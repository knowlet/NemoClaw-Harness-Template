// UNOFFICIAL native-agent integration runner. Requires a built NemoClaw checkout.
// Usage: node scripts/integration/native-agent.mjs --nemoclaw <checkout> [--name NAME] [--deploy] [--json FILE]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scaffoldNativeAgent, installNativeAgent, verifyNativeAgent } from '../../src/index.mjs';

function parse(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error('Unexpected argument: ' + args[i]);
    const key = args[i].slice(2);
    if (key === 'deploy') { flags.deploy = true; continue; }
    if (!['nemoclaw', 'name', 'sandbox', 'json'].includes(key)) throw new Error('Unknown option: --' + key);
    if (args[i + 1] === undefined) throw new Error('Missing value for --' + key);
    flags[key] = args[++i];
  }
  if (!flags.nemoclaw) throw new Error('--nemoclaw <checkout> is required');
  return flags;
}

function run(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const out = [], err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

const flags = parse(process.argv.slice(2));
const checkout = path.resolve(flags.nemoclaw);
const name = flags.name ?? 'native-echo';
const sandbox = flags.sandbox ?? 'nha-native';
const cli = path.join(checkout, 'bin', 'nemoclaw.js');
const report = { unofficial: true, checkout, name, sandbox, loaderAccepted: false, deploymentVerified: false, checks: [] };
const workspace = await mkdtemp(path.join(os.tmpdir(), 'nha-native-integration-'));
try {
  const pack = path.join(workspace, name);
  await scaffoldNativeAgent(pack, { name, displayName: 'Native Echo', model: 'fixture-model' });
  report.checks.push('scaffold');
  const installed = await installNativeAgent(pack, { nemoclawRoot: checkout, replace: true });
  report.checks.push('install');
  report.agentDir = installed.agentDir;

  const verification = await verifyNativeAgent({ nemoclawRoot: checkout, name });
  report.loaderAccepted = verification.loaderAccepted === true;
  report.workload = verification.workload;
  if (report.loaderAccepted) report.checks.push('loader-accepted');
  if (!report.loaderAccepted) throw new Error('The NemoClaw loader rejected agent ' + name + ': ' + (verification.error ?? 'no detail'));

  if (flags.deploy) {
    const onboard = await run([process.execPath, cli, 'onboard', '--name', sandbox, '--agent', name, '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh'], { cwd: checkout });
    report.onboardExit = onboard.code;
    if (onboard.code !== 0) {
      // Do not forward arbitrary onboarding output: it can echo provider configuration.
      report.onboardTail = onboard.stderr.split(String.fromCharCode(10)).slice(-5).join(String.fromCharCode(10));
      throw new Error('NemoClaw onboarding failed with exit ' + String(onboard.code));
    }
    report.checks.push('onboard');
    // Use the manifest binary_path so this also proves the launcher NemoClaw requires.
    const task = await run([process.execPath, cli, sandbox, 'exec', '--', '/usr/local/bin/' + name, 'NHA_NATIVE_OK'], { cwd: checkout });
    report.execExit = task.code;
    report.deploymentVerified = task.code === 0 && task.stdout.includes('Echo: NHA_NATIVE_OK');
    if (report.deploymentVerified) report.checks.push('sandbox-exec');
    else throw new Error('The custom harness did not run inside the NemoClaw sandbox');
  }

  console.log(JSON.stringify(report, null, 2));
  if (flags.json) await writeFile(flags.json, JSON.stringify(report, null, 2) + String.fromCharCode(10));
} finally {
  await rm(workspace, { recursive: true, force: true });
  if (!report.loaderAccepted) process.exitCode = 1;
  else if (flags.deploy && !report.deploymentVerified) process.exitCode = 1;
}

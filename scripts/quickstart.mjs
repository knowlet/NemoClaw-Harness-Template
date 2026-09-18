#!/usr/bin/env node
/** UNOFFICIAL native quickstart runner. It executes the documented tutorial steps in order. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const REVISION = '1eb370f20530bd1312ac86a27782ef8501b28ade';
const NEMOCLAW_REPO = 'https://github.com/NVIDIA/NemoClaw.git';
const FIXTURE_PORT = 18080;

const USAGE = [
  'Usage: node scripts/quickstart.mjs [options]',
  '',
  '  --workdir DIR     Where to work (default: ./quickstart-work)',
  '  --nemoclaw PATH   Reuse an already built NemoClaw checkout',
  '  --name NAME       Agent name (default: my-harness)',
  '  --sandbox NAME    Sandbox name (default: my-sandbox)',
  '  --model MODEL     Model id recorded in the agent manifest (default: fixture-model)',
  '  --destroy         Delete the sandbox at the end',
  '  --customize       Change the payload, redeploy, and require the new output',
  '  --dry-run         Print the steps without running them',
  '',
  'Set NEMOCLAW_ENDPOINT_URL, NEMOCLAW_MODEL, NEMOCLAW_PROVIDER_KEY, and NEMOCLAW_PROVIDER',
  'to onboard against your own inference endpoint. Otherwise a deterministic local fixture is used.',
].join(String.fromCharCode(10));

function parse(argv) {
  const flags = { name: 'my-harness', sandbox: 'my-sandbox', model: 'fixture-model', workdir: 'quickstart-work' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--destroy' || key === '--dry-run' || key === '--customize') { flags[key.slice(2)] = true; continue; }
    if (key === '--help' || key === '-h') { flags.help = true; continue; }
    if (!['--workdir', '--nemoclaw', '--name', '--sandbox', '--model'].includes(key)) throw new Error('Unknown option: ' + key);
    if (argv[i + 1] === undefined) throw new Error('Missing value for ' + key);
    flags[key.slice(2)] = argv[++i];
  }
  return flags;
}

function show(command) { console.log('  $ ' + command); }

function run(label, argv, options = {}) {
  console.log('');
  console.log('== ' + label);
  show(argv.join(' '));
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(label + ' could not start: ' + result.error.message);
  const out = result.stdout ?? '';
  const err = result.stderr ?? '';
  if (result.status !== 0 && !options.allowFailure) {
    if (err.trim()) console.error(err.trim().split(String.fromCharCode(10)).slice(-20).join(String.fromCharCode(10)));
    throw new Error(label + ' failed with exit ' + String(result.status));
  }
  return { code: result.status, stdout: out, stderr: err };
}

function preflight() {
  console.log('== Preflight');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw new Error('Node 22.16 or newer is required; found ' + process.version);
  if (major < 24) console.log('  ! Node ' + process.version + ' works for the SDK, but the managed launch path is validated on Node 24.');
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) throw new Error('A working Docker daemon is required');
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('git is required');
  console.log('  node ' + process.version + ', docker and git found');
}

async function ensureNemoclaw(flags, workdir, env) {
  if (flags.nemoclaw) {
    const checkout = path.resolve(flags.nemoclaw);
    if (!existsSync(path.join(checkout, 'bin', 'nemoclaw.js'))) throw new Error('No NemoClaw CLI at ' + checkout);
    if (!existsSync(path.join(checkout, 'dist', 'lib', 'agent', 'defs.js'))) {
      throw new Error('That checkout is not built; run its "npm run build:cli" first');
    }
    const version = run('Use the existing NemoClaw checkout', [process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), '--version'], { env });
    console.log('  using ' + checkout + ' (' + version.stdout.trim() + ')');
    return checkout;
  }
  const checkout = path.join(workdir, 'NemoClaw');
  if (existsSync(path.join(checkout, 'bin', 'nemoclaw.js'))) {
    console.log('  reusing the checkout already present at ' + checkout);
  } else {
    await mkdir(checkout, { recursive: true });
    run('Clone the pinned NemoClaw revision', ['git', 'init', '-q', '.'], { cwd: checkout, env });
    run('Fetch ' + REVISION, ['git', 'remote', 'add', 'origin', NEMOCLAW_REPO], { cwd: checkout, env });
    run('Check out the pinned revision', ['git', 'fetch', '--depth', '1', 'origin', REVISION], { cwd: checkout, env, inherit: true });
    run('Check out FETCH_HEAD', ['git', 'checkout', '-q', 'FETCH_HEAD'], { cwd: checkout, env });
  }
  if (!existsSync(path.join(checkout, 'dist', 'lib', 'agent', 'defs.js'))) {
    run('Install NemoClaw dependencies', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, env, inherit: true });
    run('Install NemoClaw plugin dependencies', ['npm', '--prefix', 'nemoclaw', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, env, inherit: true });
    run('Build the NemoClaw CLI', ['npm', 'run', 'build:cli'], { cwd: checkout, env, inherit: true });
  }
  const version = run('Check the NemoClaw CLI', [process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), '--version'], { env });
  console.log('  ' + version.stdout.trim());
  return checkout;
}

function ensureOpenShell(checkout, env) {
  const installer = path.join(checkout, 'scripts', 'install-openshell.sh');
  run('Install the checksum-pinned OpenShell CLI, gateway, and sandbox', ['bash', installer], {
    cwd: checkout, env: { ...env, NEMOCLAW_NON_INTERACTIVE: '1' }, inherit: true,
  });
  const dirs = [path.join(process.env.HOME ?? '', '.local', 'bin'), '/usr/local/bin'];
  const found = dirs.find((dir) => existsSync(path.join(dir, 'openshell')));
  if (!found) throw new Error('OpenShell was installed but could not be located');
  const probe = spawnSync(path.join(found, 'openshell'), ['--version'], { encoding: 'utf8' });
  const version = (probe.stdout ?? '').trim();
  if (!version) throw new Error('The installed openshell binary did not report a version');
  console.log('  ' + version);
  return { dir: found, version };
}

async function startFixture(env) {
  const provider = spawn(process.execPath, [path.join(REPO, 'scripts', 'integration', 'fixture-provider.mjs')], {
    env, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
  });
  provider.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(FIXTURE_PORT) + '/v1/models');
      if (response.ok) return provider;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  throw new Error('The local inference fixture did not start');
}

function providerEnvironment(flags, env) {
  if (env.NEMOCLAW_ENDPOINT_URL) {
    console.log('  using the inference endpoint from NEMOCLAW_ENDPOINT_URL');
    return { env, fixture: null };
  }
  console.log('  no NEMOCLAW_ENDPOINT_URL set; using the deterministic local fixture (no model is called)');
  return {
    env: {
      ...env,
      NEMOCLAW_PROVIDER: env.NEMOCLAW_PROVIDER ?? 'custom',
      NEMOCLAW_MODEL: flags.model,
      NEMOCLAW_PROVIDER_KEY: env.NEMOCLAW_PROVIDER_KEY ?? 'fixture-only-not-a-secret',
      NEMOCLAW_ENDPOINT_URL: 'http://host.openshell.internal:' + String(FIXTURE_PORT) + '/v1',
    },
    fixture: true,
  };
}

function destroySandbox(checkout, sandbox, env) {
  const result = run('Delete the sandbox', [process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), sandbox, 'destroy', '--yes', '--force'], { env, allowFailure: true });
  const text = (result.stdout + result.stderr).trim();
  if (text) console.log('  ' + text.split(String.fromCharCode(10)).join(String.fromCharCode(10) + '  '));
  if (result.code === 0) return { ok: true, detail: null };
  // A sandbox that is already absent is a clean end state, not a failure.
  if (/does not exist|already absent|not found/i.test(text)) return { ok: true, detail: null };
  const detail = text.split(String.fromCharCode(10)).filter(Boolean).slice(-2).join(' ');
  return { ok: false, detail: detail || ('exit ' + String(result.code)) };
}

function deploy(checkout, flags, env, expected) {
  run('Onboard the agent with the real NemoClaw CLI', [
    process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), 'onboard',
    '--agent', flags.name, '--name', flags.sandbox,
    '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh',
  ], { env, inherit: true });
  const exec = run('Run the harness inside the sandbox', [
    process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), flags.sandbox, 'exec', '--', '/usr/local/bin/' + flags.name, expected.task,
  ], { env });
  console.log('');
  console.log('  sandbox output: ' + exec.stdout.trim());
  if (!exec.stdout.includes(expected.expect)) {
    throw new Error('the sandbox returned ' + JSON.stringify(exec.stdout.trim()) + ' instead of ' + JSON.stringify(expected.expect));
  }
}

/**
 * The documented customization loop, asserted rather than described: change the
 * payload in the package, keep the package test passing, reinstall, redeploy,
 * and require the sandbox to return the new output. Without this a stale image
 * would still look like success.
 */
function customizePass(packDir, checkout, flags, env) {
  console.log('');
  console.log('== Customize the harness and redeploy');
  const harnessFile = path.join(packDir, 'harness.mjs');
  const testFile = path.join(packDir, 'harness.test.mjs');
  const harness = readFileSync(harnessFile, 'utf8');
  if (!harness.includes('"Echo: "')) throw new Error('the starter harness no longer contains the expected echo prefix');
  writeFileSync(harnessFile, harness.split('"Echo: "').join('"V2 Echo: "'));
  const test = readFileSync(testFile, 'utf8');
  writeFileSync(testFile, test.split("'Echo: ").join("'V2 Echo: "));
  run('Run the package contract test after the change', [process.execPath, '--test', testFile], { env, inherit: true });
  run('Reinstall the changed package', [process.execPath, path.join(REPO, 'bin', 'nha.mjs'), 'native', 'install', packDir, '--nemoclaw', checkout, '--replace'], { env });
  const removed = destroySandbox(checkout, flags.sandbox, env);
  if (!removed.ok) throw new Error('could not delete the sandbox before redeploying: ' + removed.detail);
  deploy(checkout, flags, env, { task: 'NHA_NATIVE_V2', expect: 'V2 Echo: NHA_NATIVE_V2' });
}

async function main() {
  const flags = parse(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); return; }
  if (flags['dry-run']) {
    console.log([
      'Steps this runner performs, in order:',
      '  1. preflight: node >= 22.16, docker, git',
      '  2. clone NVIDIA/NemoClaw and check out ' + REVISION,
      '  3. npm ci, npm --prefix nemoclaw ci, npm run build:cli',
      '  4. install the checksum-pinned OpenShell (scripts/install-openshell.sh)',
      '  5. node bin/nha.mjs native init ' + flags.workdir + '/' + flags.name + ' --name ' + flags.name,
      '  6. node --test ' + flags.workdir + '/' + flags.name + '/harness.test.mjs',
      '  7. node bin/nha.mjs native install ' + flags.workdir + '/' + flags.name + ' --nemoclaw <checkout> --replace',
      '  8. node bin/nha.mjs native verify --nemoclaw <checkout> --name ' + flags.name,
      '  9. node <checkout>/bin/nemoclaw.js onboard --agent ' + flags.name + ' --name ' + flags.sandbox + ' ...',
      ' 10. node <checkout>/bin/nemoclaw.js ' + flags.sandbox + ' exec -- /usr/local/bin/' + flags.name + ' NHA_NATIVE_OK',
      flags.customize ? ' 11. change the payload, rerun the package test, reinstall, redeploy, require "V2 Echo: NHA_NATIVE_V2"' : ' 11. (--customize runs the change/redeploy loop above)',
    ].join(String.fromCharCode(10)));
    return;
  }

  const workdir = path.resolve(flags.workdir);
  await mkdir(workdir, { recursive: true });
  preflight();

  const baseEnv = { ...process.env };
  const checkout = await ensureNemoclaw(flags, workdir, baseEnv);
  const openshell = ensureOpenShell(checkout, baseEnv);
  const env = { ...baseEnv, PATH: openshell.dir + path.delimiter + (baseEnv.PATH ?? '') };

  const packDir = path.join(workdir, flags.name);
  if (!existsSync(packDir)) {
    run('Create the native agent package', [process.execPath, path.join(REPO, 'bin', 'nha.mjs'), 'native', 'init', packDir, '--name', flags.name, '--model', flags.model], { env });
  } else {
    console.log('');
    console.log('  reusing the package at ' + packDir);
  }
  run('Run the package contract test', [process.execPath, '--test', path.join(packDir, 'harness.test.mjs')], { env, inherit: true });
  run('Install it into the NemoClaw checkout', [process.execPath, path.join(REPO, 'bin', 'nha.mjs'), 'native', 'install', packDir, '--nemoclaw', checkout, '--replace'], { env });
  const verify = run('Ask the real NemoClaw loader', [process.execPath, path.join(REPO, 'bin', 'nha.mjs'), 'native', 'verify', '--nemoclaw', checkout, '--name', flags.name], { env });
  const report = JSON.parse(verify.stdout);
  if (report.loaderAccepted !== true) throw new Error('The NemoClaw loader did not accept the agent');

  const provider = providerEnvironment(flags, env);
  const fixture = provider.fixture ? await startFixture(env) : null;
  let deployError = null;
  try {
    deploy(checkout, flags, provider.env, { task: 'NHA_NATIVE_OK', expect: 'Echo: NHA_NATIVE_OK' });
    if (flags.customize) customizePass(packDir, checkout, flags, provider.env);
  } catch (error) {
    deployError = error;
  } finally {
    if (fixture) fixture.kill('SIGTERM');
  }

  // Cleanup runs even when the deploy failed: a retained sandbox from a failed
  // attempt blocks the next onboarding under the same name.
  let cleanupError = null;
  if (flags.destroy) {
    const removed = destroySandbox(checkout, flags.sandbox, provider.env);
    if (!removed.ok) cleanupError = new Error('the sandbox could not be deleted: ' + removed.detail);
  }
  if (deployError) throw deployError;
  if (cleanupError) throw cleanupError;
  console.log('');
  console.log('QUICKSTART OK: NemoClaw built agents/' + flags.name + ', created sandbox ' + flags.sandbox + ', and ran the launcher inside it'
    + (flags.customize ? ', then redeployed a changed payload and verified the new output' : '') + '.');
}

main().catch((error) => {
  console.error('');
  console.error('QUICKSTART FAILED: ' + (error instanceof Error ? error.message : String(error)));
  console.error('See docs/QUICKSTART.md for the same steps one at a time plus a troubleshooting section.');
  process.exitCode = 1;
});

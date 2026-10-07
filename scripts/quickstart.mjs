#!/usr/bin/env node
/** UNOFFICIAL native quickstart with bounded commands and durable phase evidence. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySandboxPreflightResult } from './lib/sandbox-cleanup.mjs';
import {
  cleanupSandbox, collectSandboxDiagnostics, commandResult, errorResult, gatewayArgs, gatewayStatusIsConnected, gatewayWorkspace,
  probeNativeState, readStructuredReport, resolveGatewayBinding, run, sanitize, serializeReport,
  terminateActiveCommands, writeReportAtomically,
} from './lib/qualification.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SDK_CLI = path.join(REPO, 'bin', 'nha.mjs');
const REVISION = '1ccec4e141b0a830229ef68c96639851d24810fd';
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SANDBOX = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,18}$/;
const USAGE = [
  'Usage: node scripts/quickstart.mjs [options]', '',
  '  --workdir DIR     Where to work (default: ./quickstart-work)',
  '  --nemoclaw PATH   Reuse an already built NemoClaw checkout',
  '  --name NAME       Agent name (default: my-harness)',
  '  --sandbox NAME    Sandbox name (default: my-sandbox)',
  '  --model MODEL     Manifest model id (default: fixture-model)',
  '  --gateway NAME   Gateway derived from NEMOCLAW_GATEWAY_PORT (default port: 8080)',
  '  --json FILE      Phase report (default: a new quickstart-<id>.json in workdir)',
  '  --timeout-ms MS  Deadline per command (default: 900000)',
  '  --destroy        Delete this run\'s sandbox at the end',
  '  --customize      Change the payload, redeploy, and require the new output',
  '  --dry-run        Print the steps without running them', '',
  'Set NEMOCLAW_ENDPOINT_URL, NEMOCLAW_MODEL, NEMOCLAW_PROVIDER_KEY, and NEMOCLAW_PROVIDER',
  'to use your inference endpoint. Otherwise a deterministic local fixture is used.',
].join('\n');

function parse(argv) {
  const flags = { name: 'my-harness', sandbox: 'my-sandbox', model: 'fixture-model', workdir: 'quickstart-work' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) throw new Error('Repeated option: ' + key);
    seen.add(key);
    if (['--destroy', '--dry-run', '--customize'].includes(key)) { flags[key.slice(2)] = true; continue; }
    if (key === '--help' || key === '-h') { flags.help = true; continue; }
    if (!['--workdir', '--nemoclaw', '--name', '--sandbox', '--model', '--gateway', '--json', '--timeout-ms'].includes(key)) throw new Error('Unknown option: ' + key);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('Missing value for ' + key);
    flags[key.slice(2)] = argv[++i];
  }
  if (!NAME.test(flags.name)) throw new Error('Invalid agent name');
  if (!SANDBOX.test(flags.sandbox)) throw new Error('Invalid sandbox name (1-19 lowercase letters, digits, and single internal hyphens)');
  flags.timeoutMs = Number(flags['timeout-ms'] ?? 900000);
  if (!Number.isSafeInteger(flags.timeoutMs) || flags.timeoutMs < 1 || flags.timeoutMs > 2147483647) throw new Error('--timeout-ms must be an integer from 1 to 2147483647');
  return flags;
}
function log(value = '') { console.log(sanitize(value)); }

async function ensureNemoclaw(ctx, flags, workdir) {
  const checkout = flags.nemoclaw ? path.resolve(flags.nemoclaw) : path.join(workdir, 'NemoClaw');
  if (flags.nemoclaw) {
    if (!existsSync(path.join(checkout, 'bin', 'nemoclaw.js'))) throw new Error('No NemoClaw CLI at ' + checkout);
    if (!existsSync(path.join(checkout, 'dist', 'lib', 'agent', 'defs.js'))) throw new Error('That checkout is not built; run its "npm run build:cli" first');
  } else {
    if (!existsSync(path.join(checkout, 'bin', 'nemoclaw.js'))) {
      await mkdir(checkout, { recursive: true });
      await ctx.execute('checkoutInit', 'Prepare the pinned NemoClaw checkout', ['git', 'init', '-q', '.'], { cwd: checkout });
      const origin = await ctx.execute('checkoutRemoteProbe', 'Inspect the NemoClaw origin', ['git', 'config', '--get', 'remote.origin.url'], { cwd: checkout, allowFailure: true });
      if (origin.code === 0 && origin.stdout.trim() !== 'https://github.com/NVIDIA/NemoClaw.git') throw new Error('The existing checkout origin is not NVIDIA/NemoClaw');
      if (origin.code === 1 && !origin.errorCode && !origin.timedOut && !origin.signal) {
        ctx.report.stages.checkoutRemoteProbe = { status: 'passed', present: false };
        await ctx.execute('checkoutRemote', 'Set the NemoClaw origin', ['git', 'remote', 'add', 'origin', 'https://github.com/NVIDIA/NemoClaw.git'], { cwd: checkout });
      } else if (origin.code !== 0 || origin.timedOut || origin.signal || origin.errorCode) throw new Error('Cannot inspect the checkout origin');
      await ctx.execute('checkoutFetch', 'Fetch ' + REVISION, ['git', 'fetch', '--depth', '1', 'origin', REVISION], { cwd: checkout, showOutput: true });
      await ctx.execute('checkoutRevision', 'Check out FETCH_HEAD', ['git', 'checkout', '-q', 'FETCH_HEAD'], { cwd: checkout });
    } else log('  reusing the checkout already present at ' + checkout);
    if (!existsSync(path.join(checkout, 'dist', 'lib', 'agent', 'defs.js'))) {
      await ctx.execute('nemoclawDependencies', 'Install NemoClaw dependencies', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, showOutput: true });
      await ctx.execute('pluginDependencies', 'Install NemoClaw plugin dependencies', ['npm', '--prefix', 'nemoclaw', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, showOutput: true });
      await ctx.execute('nemoclawBuild', 'Build the NemoClaw CLI', ['npm', 'run', 'build:cli'], { cwd: checkout, showOutput: true });
    }
  }
  const version = await ctx.execute('nemoclawVersion', 'Check the NemoClaw CLI', [process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), '--version'], { cwd: checkout });
  log('  using ' + checkout + ' (' + version.stdout.trim() + ')');
  return checkout;
}
async function ensureOpenShell(ctx, checkout) {
  await ctx.execute('openshellInstall', 'Install the checksum-pinned OpenShell CLI, gateway, and sandbox', ['bash', path.join(checkout, 'scripts', 'install-openshell.sh')], { cwd: checkout, env: { ...ctx.env, NEMOCLAW_NON_INTERACTIVE: '1' }, showOutput: true });
  const found = [path.join(ctx.env.HOME ?? '', '.local', 'bin'), '/usr/local/bin'].find((dir) => existsSync(path.join(dir, 'openshell')));
  if (!found) throw new Error('OpenShell was installed but could not be located');
  ctx.env = { ...ctx.env, PATH: found + path.delimiter + (ctx.env.PATH ?? '') };
  const version = await ctx.execute('openshellVersion', 'Check the OpenShell CLI', ['openshell', '--version']);
  if (!version.stdout.trim()) throw new Error('The installed openshell binary did not report a version');
  log('  ' + version.stdout.trim());
}

// Readiness is emitted by this child only after it binds the port. An unrelated
// listener on port 18080 can never be mistaken for a fixture owned by this run.
async function startFixture(env, signal, timeoutMs) {
  const provider = spawn(process.execPath, [path.join(REPO, 'scripts', 'integration', 'fixture-provider.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const kill = (name) => {
    if (provider.exitCode !== null || provider.signalCode !== null) return;
    try { if (process.platform !== 'win32' && provider.pid) process.kill(-provider.pid, name); else provider.kill(name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => new Promise((resolve) => {
    if (provider.exitCode !== null || provider.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 1000);
    provider.once('exit', () => { clearTimeout(timer); resolve(); });
    kill('SIGTERM');
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      let finished = false;
      const timer = setTimeout(() => finish(new Error('The local inference fixture did not start before its deadline')), Math.min(timeoutMs, 20000));
      const abort = () => finish(Object.assign(new Error('Run interrupted'), { code: 'INTERRUPTED' }));
      const exit = () => finish(new Error('The local inference fixture exited before readiness; check whether port 18080 is in use'));
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        provider.removeListener('exit', exit);
        if (error) reject(error); else resolve();
      };
      provider.once('error', finish);
      provider.once('exit', exit);
      provider.stdout.on('data', (chunk) => { output = (output + chunk.toString('utf8')).slice(-256); if (output.includes('Deterministic integration fixture listening;')) finish(); });
      provider.stderr.on('data', () => {});
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return { stop };
  } catch (error) { await stop(); throw error; }
}
function providerEnvironment(flags, env) {
  if (env.NEMOCLAW_ENDPOINT_URL) { log('  using the inference endpoint from NEMOCLAW_ENDPOINT_URL'); return { env, fixture: false }; }
  log('  no NEMOCLAW_ENDPOINT_URL set; using the deterministic local fixture (no model is called)');
  return { env: { ...env, NEMOCLAW_PROVIDER: env.NEMOCLAW_PROVIDER ?? 'custom', NEMOCLAW_MODEL: flags.model,
    NEMOCLAW_PROVIDER_KEY: env.NEMOCLAW_PROVIDER_KEY ?? 'fixture-only-not-a-secret', NEMOCLAW_ENDPOINT_URL: 'http://host.openshell.internal:18080/v1' }, fixture: true };
}
async function probeOwnership(ctx, flags, key = 'preflight') {
  const nativeKey = key === 'preflight' ? 'nativeState' : 'customizeNativeState';
  await ctx.phase(nativeKey, async () => {
    ctx.report.nativeState = await probeNativeState(ctx.report, flags, { env: ctx.env });
    ctx.report.stages[nativeKey] = { ...ctx.report.nativeState };
    if (ctx.report.nativeState.status !== 'passed') {
      ctx.report.sandbox.ownership = ctx.report.nativeState.ownership === 'pre-existing' ? 'pre-existing' : 'unknown';
      ctx.report.sandbox.preflight = 'failed';
      throw new Error(ctx.report.nativeState.error ?? 'Native sandbox state is not available for this run');
    }
  });
  const outcome = await ctx.execute(key, 'Confirm the sandbox name is unused on the bound gateway', ['openshell', 'sandbox', 'get', ...gatewayArgs(flags), flags.sandbox], { allowFailure: true });
  const verdict = classifySandboxPreflightResult({ ...outcome, sandbox: flags.sandbox });
  const truncated = outcome.stdoutTruncated || outcome.stderrTruncated;
  const owned = verdict.ok && !outcome.timedOut && !outcome.errorCode && !outcome.signal && !outcome.cancelled && !truncated;
  ctx.report.sandbox.ownership = owned ? 'owned' : verdict.preexisting ? 'pre-existing' : 'unknown';
  ctx.report.sandbox.preflight = owned ? 'absent' : verdict.preexisting ? 'present' : 'failed';
  if (owned) ctx.report.nativeState.ownership = 'owned';
  ctx.report.stages[key] = { ...ctx.report.stages[key], status: owned ? 'passed' : 'failed', ownership: ctx.report.sandbox.ownership };
  if (!owned) ctx.report.stages[key].errorCode = outcome.timedOut ? 'TIMEOUT' : truncated ? 'OUTPUT_LIMIT' : outcome.cancelled ? 'INTERRUPTED' : outcome.errorCode ?? verdict.errorCode ?? 'SANDBOX_PREFLIGHT_FAILED';
  await ctx.persist();
  if (!owned) throw new Error(verdict.detail ?? 'Sandbox ownership could not be established');
}
async function destroySandbox(ctx, checkout, flags, key) {
  await ctx.phase(key, async () => {
    log('== Delete and verify this run\'s sandbox');
    // Keep customization cleanup separate from final cleanup so a successful
    // first deletion cannot suppress cleanup of the redeployed sandbox.
    const cleanup = { ...ctx.report, checkout, stages: { ...ctx.report.stages } };
    delete cleanup.stages.cleanup;
    await cleanupSandbox(cleanup, { ...flags, deploy: true }, async (argv, options = {}) => {
      log('  $ ' + (argv.includes('-e') ? argv[0] + ' [native lifecycle probe]' : argv.join(' ')));
      const outcome = await run(argv, { cwd: checkout, ...options,
        env: { ...ctx.env, ...options.env, PATH: ctx.env.PATH },
        timeoutMs: Math.min(flags.timeoutMs, options.timeoutMs ?? 60000) });
      if (outcome.stderr && outcome.code !== 0) console.error(sanitize(outcome.stderr.trim()));
      return outcome;
    }, { env: ctx.env });
    ctx.report.stages[key] = cleanup.stages.cleanup;
    if (cleanup.stages.cleanup?.status !== 'passed') throw new Error('The sandbox cleanup could not be verified');
  });
}

async function deploy(ctx, checkout, flags, expected, prefix = '') {
  const stage = (name) => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
  await ctx.execute(stage('onboard'), 'Onboard the agent with the real NemoClaw CLI', [process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), 'onboard', '--agent', flags.name, '--name', flags.sandbox,
    '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh'], { cwd: checkout, showOutput: true });
  await ctx.execute(stage('sandbox'), 'Verify the sandbox is on the bound gateway', ['openshell', 'sandbox', 'get', ...gatewayArgs(flags), flags.sandbox]);
  const outcome = await ctx.execute(stage('exec'), 'Run the harness inside the sandbox', [process.execPath, path.join(checkout, 'bin', 'nemoclaw.js'), flags.sandbox, 'exec', '--', '/usr/local/bin/' + flags.name, expected.task], { cwd: checkout, marker: expected.expect });
  log('  sandbox output: ' + outcome.stdout.trim());
  if (!outcome.markerSeen) { ctx.report.stages[stage('exec')] = { ...ctx.report.stages[stage('exec')], status: 'failed', errorCode: 'SMOKE_MISMATCH' }; throw new Error('The sandbox did not return the expected marker ' + expected.expect); }
}
async function customizePass(ctx, packDir, checkout, flags) {
  await ctx.phase('customize', async () => {
    log('== Customize the harness and redeploy');
    const harnessFile = path.join(packDir, 'harness.mjs'), testFile = path.join(packDir, 'harness.test.mjs');
    const harness = await readFile(harnessFile, 'utf8');
    if (!harness.includes('"Echo: "')) throw new Error('The starter harness no longer contains the expected echo prefix');
    await writeFile(harnessFile, harness.replaceAll('"Echo: "', '"V2 Echo: "'));
    await writeFile(testFile, (await readFile(testFile, 'utf8')).replaceAll("'Echo: ", "'V2 Echo: "));
  });
  await ctx.execute('customizeTest', 'Run the package contract test after the change', [process.execPath, '--test', path.join(packDir, 'harness.test.mjs')], { showOutput: true });
  await ctx.execute('customizeInstall', 'Reinstall the changed package', [process.execPath, SDK_CLI, 'native', 'install', packDir, '--nemoclaw', checkout, '--replace']);
  await destroySandbox(ctx, checkout, flags, 'customizeDestroy');
  await probeOwnership(ctx, flags, 'customizePreflight');
  await deploy(ctx, checkout, flags, { task: 'NHA_NATIVE_V2', expect: 'V2 Echo: NHA_NATIVE_V2' }, 'customize');
  ctx.report.customizationVerified = true;
}

export async function main(args = process.argv.slice(2)) {
  const flags = parse(args);
  if (flags.help) { log(USAGE); return; }
  if (flags['dry-run']) {
    log(['Steps this runner performs, in order:',
      '  1. preflight: node >= 22.16, docker, git; reserve a phase report',
      '  2. build this SDK from TypeScript when dist/ is absent',
      '  3. clone NVIDIA/NemoClaw at ' + REVISION + '; npm ci, npm --prefix nemoclaw ci, npm run build:cli',
      '  4. native init ' + flags.workdir + '/' + flags.name + '; run its harness.test.mjs',
      '  5. native install --replace; native verify with the real loader',
      '  6. install checksum-pinned OpenShell through scripts/install-openshell.sh',
      '  7. bootstrap the pinned managed gateway; require an unused sandbox name',
      '  8. onboard --agent ' + flags.name + ' --name ' + flags.sandbox + '; exec the launcher and require Echo: NHA_NATIVE_OK',
      flags.customize ? '  9. customize, test, reinstall, delete the owned sandbox, redeploy, require V2 Echo: NHA_NATIVE_V2' : '  9. --customize enables the payload change/redeploy loop',
      flags.destroy ? ' 10. delete only the sandbox claimed by this run' : ' 10. retain the sandbox; --destroy requests cleanup'].join('\n'));
    return;
  }
  const workdir = path.resolve(flags.workdir);
  const reportPath = path.resolve(flags.json ?? path.join(workdir, 'quickstart-' + randomUUID().slice(0, 8) + '.json'));
  const report = { unofficial: true, schemaVersion: 'nemoclaw-quickstart/v1', generatedAt: new Date().toISOString(), reportPath,
    status: 'running', name: flags.name, workdir, mode: { destroy: flags.destroy === true, customize: flags.customize === true },
    loaderAccepted: false, deploymentVerified: false, customizationVerified: false,
    sandbox: { name: flags.sandbox, ownership: 'unknown', preflight: 'pending' }, stages: {} };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, serializeReport(report) + '\n', { flag: 'wx', mode: 0o600 });
  log('  Phase evidence: ' + reportPath);
  const controller = new AbortController();
  let interrupted, checkout, fixture, privateDir;
  let cleaning = false;
  const assertActive = () => { if (interrupted && !cleaning) throw Object.assign(new Error('Run interrupted'), { code: 'INTERRUPTED' }); };
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal; report.status = 'interrupted'; report.interrupted = { signal, at: new Date().toISOString() };
    controller.abort();
    if (!cleaning) terminateActiveCommands();
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const ctx = { report, env: { ...process.env }, persist: () => writeReportAtomically(reportPath, report) };
  ctx.record = async () => {
    try { await ctx.persist(); }
    catch (error) {
      if (!cleaning) throw error;
      report.reportError = 'Could not persist cleanup evidence';
      report.status = interrupted ? 'interrupted' : 'failed';
    }
  };
  ctx.phase = async (key, operation) => {
    assertActive(); report.stages[key] = { status: 'running' }; await ctx.record(); assertActive();
    try {
      const value = await operation(); assertActive();
      if (report.stages[key].status === 'running') report.stages[key] = { status: 'passed' };
      await ctx.record(); return value;
    } catch (error) {
      if (report.stages[key].status === 'running') report.stages[key] = errorResult(error);
      await ctx.record(); throw error;
    }
  };
  ctx.execute = (key, label, argv, options = {}) => ctx.phase(key, async () => {
    log(); log('== ' + label); log('  $ ' + argv.join(' '));
    const { allowFailure, showOutput, ...commandOptions } = options;
    const outcome = await run(argv, { cwd: workdir, env: ctx.env, timeoutMs: flags.timeoutMs, ...commandOptions });
    report.stages[key] = commandResult(outcome);
    if (showOutput && outcome.stdout) log(outcome.stdout.trim());
    if (outcome.stderr && (showOutput || report.stages[key].status !== 'passed')) console.error(sanitize(outcome.stderr.trim()));
    if (!allowFailure && report.stages[key].status !== 'passed') throw Object.assign(new Error(label + ' failed'), { code: report.stages[key].errorCode ?? 'COMMAND_FAILED' });
    return outcome;
  });
  try {
    await mkdir(workdir, { recursive: true });
    await ctx.phase('node', async () => {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 16)) throw new Error('Node 22.16 or newer is required; found ' + process.version);
      if (major < 24) log('  ! Node ' + process.version + ' works for the SDK, but the managed launch path is validated on Node 24.');
    });
    await ctx.execute('docker', 'Check Docker', ['docker', 'info']);
    await ctx.execute('git', 'Check git', ['git', '--version']);
    await ctx.phase('binding', async () => {
      const binding = resolveGatewayBinding(flags, { ...ctx.env, NEMOCLAW_GATEWAY_PORT: ctx.env.NEMOCLAW_GATEWAY_PORT || (flags.gateway ? '' : '8080') });
      if (binding.errorCode) throw Object.assign(new Error(binding.detail), { code: binding.errorCode });
      flags.gateway = binding.name; flags.gatewayPort = binding.port;
      report.gateway = { name: binding.name, port: binding.port, workspace: gatewayWorkspace(ctx.env) };
      ctx.env = { ...ctx.env, NEMOCLAW_GATEWAY_PORT: String(binding.port), OPENSHELL_GATEWAY: binding.name, OPENSHELL_WORKSPACE: report.gateway.workspace };
    });
    if (!existsSync(path.join(REPO, 'dist', 'bin', 'nha.js'))) {
      await ctx.execute('sdkDependencies', 'Install this SDK build dependencies', ['npm', 'ci', '--ignore-scripts'], { cwd: REPO, showOutput: true });
      await ctx.execute('sdkBuild', 'Build this SDK and CLI from TypeScript', ['npm', 'run', 'build'], { cwd: REPO, showOutput: true });
    }
    checkout = await ctx.phase('checkout', () => ensureNemoclaw(ctx, flags, workdir)); report.checkout = checkout;
    const packDir = path.join(workdir, flags.name);
    if (!existsSync(packDir)) await ctx.execute('scaffold', 'Create the native agent package', [process.execPath, SDK_CLI, 'native', 'init', packDir, '--name', flags.name, '--model', flags.model]);
    else { report.stages.scaffold = { status: 'skipped', reason: 'reusing an existing package' }; log('  reusing the package at ' + packDir); }
    await ctx.execute('packageTest', 'Run the package contract test', [process.execPath, '--test', path.join(packDir, 'harness.test.mjs')], { showOutput: true });
    await ctx.execute('install', 'Install it into the NemoClaw checkout', [process.execPath, SDK_CLI, 'native', 'install', packDir, '--nemoclaw', checkout, '--replace']);
    privateDir = await mkdtemp(path.join(workdir, '.quickstart-'));
    const loaderReport = path.join(privateDir, 'loader.json');
    await ctx.execute('loader', 'Ask the real NemoClaw loader', [process.execPath, SDK_CLI, 'native', 'verify', '--nemoclaw', checkout, '--name', flags.name, '--json', loaderReport]);
    let verified;
    try { verified = await readStructuredReport(loaderReport); }
    catch (error) { report.stages.loader = { ...report.stages.loader, status: 'failed', errorCode: 'INVALID_REPORT' }; throw error; }
    if (verified.loaderAccepted !== true) { report.stages.loader = { ...report.stages.loader, status: 'failed', errorCode: 'LOADER_REJECTED' }; throw new Error('The NemoClaw loader did not accept the agent'); }
    report.loaderAccepted = true; report.checkoutRevision = verified.checkoutRevision; report.supportedUpstream = verified.supportedUpstream;
    await ensureOpenShell(ctx, checkout);
    const bootstrap = ['const onboard = require("./dist/lib/onboard.js");',
      'if (typeof onboard.startDockerDriverGateway !== "function") throw new Error("The pinned gateway bootstrap is unavailable");',
      'Promise.resolve(onboard.startDockerDriverGateway({ exitOnFailure: false })).then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });'].join('\n');
    await ctx.execute('bootstrap', 'Start the pinned managed gateway before checking sandbox ownership', [process.execPath, '--input-type=commonjs', '-e', bootstrap], { cwd: checkout, env: { ...ctx.env, NEMOCLAW_NON_INTERACTIVE: '1' }, showOutput: true });
    await ctx.execute('gatewaySelect', 'Select the bound gateway', ['openshell', 'gateway', 'select', flags.gateway]);
    const status = await ctx.execute('gateway', 'Verify the gateway connection', ['openshell', 'status', ...gatewayArgs(flags)]);
    if (!gatewayStatusIsConnected(status.stdout)) { report.stages.gateway = { ...report.stages.gateway, status: 'failed', errorCode: 'GATEWAY_UNHEALTHY' }; throw new Error('The bound gateway is not connected'); }
    await probeOwnership(ctx, flags);
    const provider = providerEnvironment(flags, ctx.env); ctx.env = provider.env;
    if (provider.fixture) await ctx.phase('fixture', async () => { fixture = await startFixture(ctx.env, controller.signal, flags.timeoutMs); });
    else report.stages.fixture = { status: 'skipped', reason: 'using the configured endpoint' };
    await deploy(ctx, checkout, flags, { task: 'NHA_NATIVE_OK', expect: 'Echo: NHA_NATIVE_OK' }); report.deploymentVerified = true;
    if (flags.customize) await customizePass(ctx, packDir, checkout, flags);
    assertActive(); report.status = 'passed';
  } catch (error) {
    report.status = interrupted ? 'interrupted' : 'failed'; report.error = sanitize(error?.message ?? 'Quickstart failed');
  } finally {
    cleaning = true;
    if (report.status !== 'passed' && report.sandbox.ownership === 'owned') {
      try {
        await collectSandboxDiagnostics(report, { ...flags, deploy: true }, (argv, options) => run(argv, { ...options, env: ctx.env }));
        await ctx.record();
      } catch { report.diagnosticsError = 'Could not collect sandbox diagnostics'; }
    }
    try {
      if (checkout && report.sandbox.ownership === 'owned' && (flags.destroy || interrupted)) await destroySandbox(ctx, checkout, flags, 'cleanup');
      else report.stages.cleanup = { status: 'skipped', ownership: report.sandbox.ownership, reason: report.sandbox.ownership !== 'owned' ? 'sandbox ownership was not established by this run' : 'sandbox retained; --destroy was not requested' };
    } catch (error) {
      if (!report.stages.cleanup || report.stages.cleanup.status === 'running') report.stages.cleanup = errorResult(error, 'infrastructure');
      report.status = interrupted ? 'interrupted' : 'failed'; report.cleanupError = sanitize(error?.message ?? 'Sandbox cleanup failed');
    }
    try { if (fixture) await fixture.stop(); if (privateDir) await rm(privateDir, { recursive: true, force: true }); }
    catch (error) { report.status = interrupted ? 'interrupted' : 'failed'; report.localCleanupError = sanitize(error?.message ?? 'Local cleanup failed'); }
    if (interrupted) report.status = 'interrupted'; report.completedAt = new Date().toISOString();
    try { await ctx.persist(); } catch { report.status = interrupted ? 'interrupted' : 'failed'; report.reportError = 'Could not persist the final report'; }
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    if (report.status === 'passed') log('QUICKSTART OK: NemoClaw built agents/' + flags.name + ', created sandbox ' + flags.sandbox + ', and ran the launcher inside it' + (flags.customize ? ', then redeployed a changed payload and verified the new output' : '') + '.');
    else { console.error(sanitize('QUICKSTART FAILED: ' + (report.error ?? report.cleanupError ?? report.localCleanupError ?? report.reportError ?? 'Run interrupted'))); log('See docs/QUICKSTART.md and the phase report for diagnostics.'); }
    log('  Phase evidence: ' + reportPath);
    if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
    else if (report.status !== 'passed') process.exitCode = 1;
  }
  return report;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(sanitize('QUICKSTART FAILED: ' + (error?.message ?? String(error)))); process.exitCode = 1; });
}

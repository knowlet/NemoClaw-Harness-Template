// UNOFFICIAL native-agent qualification. Requires a built, pinned NemoClaw checkout.
// Usage: node scripts/integration/native-agent.mjs --nemoclaw PATH [--deploy] [--json FILE]
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySandboxPreflightResult } from '../lib/sandbox-cleanup.mjs';
import {
  cleanupSandbox, collectSandboxDiagnostics, commandResult, deployEnv, errorResult, gatewayArgs,
  gatewayStatusIsConnected, gatewayWorkspace, probeNativeState, resolveGatewayBinding, run,
  readStructuredReport, sanitize, serializeReport, terminateActiveCommands, writeReportAtomically,
} from '../lib/qualification.mjs';

const SDK_CLI = fileURLToPath(new URL('../../bin/nha.mjs', import.meta.url));
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SANDBOX = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,18}$/;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function parse(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error('Unexpected argument: ' + args[i]);
    const key = args[i].slice(2);
    if (key in flags) throw new Error('Repeated option: --' + key);
    if (key === 'deploy') { flags.deploy = true; continue; }
    if (!['nemoclaw', 'name', 'sandbox', 'json', 'gateway', 'timeout-ms'].includes(key)) throw new Error('Unknown option: --' + key);
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('Missing value for --' + key);
    flags[key] = args[++i];
  }
  if (!flags.nemoclaw) throw new Error('--nemoclaw <checkout> is required');
  if (flags.name !== undefined && !NAME.test(flags.name)) throw new Error('Invalid agent name');
  if (flags.sandbox !== undefined && !SANDBOX.test(flags.sandbox)) throw new Error('Invalid sandbox name (1-19 lowercase letters, digits, and single internal hyphens)');
  if (flags.gateway !== undefined && !NAME.test(flags.gateway)) throw new Error('Invalid gateway name');
  flags.timeoutMs = Number(flags['timeout-ms'] ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(flags.timeoutMs) || flags.timeoutMs < 1 || flags.timeoutMs > 2147483647) throw new Error('--timeout-ms must be an integer from 1 to 2147483647');
  return flags;
}

export async function main(args = process.argv.slice(2)) {
  const flags = parse(args);
  const checkout = path.resolve(flags.nemoclaw);
  const name = flags.name ?? 'native-echo';
  const token = randomUUID().replaceAll('-', '').slice(0, 10);
  const sandbox = flags.sandbox ?? 'native-' + token;
  const cli = path.join(checkout, 'bin', 'nemoclaw.js');
  const reportPath = path.resolve(flags.json ?? path.join('reports', 'native-' + token + '.json'));
  const report = {
    unofficial: true, schemaVersion: 'nemoclaw-native-integration/v1',
    generatedAt: new Date().toISOString(), reportPath, checkout, name, sandbox,
    mode: { deploy: flags.deploy === true }, status: 'running',
    loaderAccepted: false, deploymentVerified: false, checks: [], stages: {},
    sandboxResource: { name: sandbox, ownership: 'unknown', preflight: 'pending' },
  };
  // Reserve evidence before changing the checkout or creating resources.
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, serializeReport(report) + '\n', { flag: 'wx', mode: 0o600 });
  const persist = () => writeReportAtomically(reportPath, report);
  let workspace;
  let interrupted;
  let cleaning = false;
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    report.interrupted = { signal, at: new Date().toISOString() };
    report.status = 'interrupted';
    // Await command settlement before cleanup: onboarding must not recreate a
    // sandbox after deletion. Cleanup itself has a bounded timeout.
    if (!cleaning) terminateActiveCommands();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const assertActive = () => {
    if (interrupted) throw Object.assign(new Error('Run interrupted'), { code: 'INTERRUPTED' });
  };
  const stage = async (key, operation) => {
    assertActive();
    report.stages[key] = { status: 'running' };
    await persist();
    assertActive();
    try {
      const value = await operation();
      assertActive();
      if (report.stages[key].status === 'running') report.stages[key] = { status: 'passed' };
      await persist();
      return value;
    } catch (error) {
      if (report.stages[key].status === 'running') report.stages[key] = errorResult(error);
      await persist();
      throw error;
    }
  };
  const command = async (key, argv, options = {}) => {
    const outcome = await run(argv, { cwd: checkout, env: deployEnv(flags), timeoutMs: flags.timeoutMs, ...options });
    report.stages[key] = commandResult(outcome);
    if (key === 'onboard') report.onboardExit = outcome.code;
    if (key === 'exec') report.execExit = outcome.code;
    if (report.stages[key].status !== 'passed') {
      throw Object.assign(new Error(key + ' command failed'), { code: report.stages[key].errorCode ?? 'COMMAND_FAILED' });
    }
    return outcome;
  };
  // Running the SDK CLI through the same command wrapper also bounds Git and
  // loader subprocesses, and lets cancellation terminate their process group.
  const sdk = async (key, argv) => stage(key, async () => {
    const structured = key === 'loader' ? path.join(workspace, 'loader.json') : null;
    const outcome = await command(key, [process.execPath, SDK_CLI, 'native', ...argv, ...(structured ? ['--json', structured] : [])], { cwd: workspace });
    try { return structured ? await readStructuredReport(structured) : JSON.parse(outcome.stdout); }
    catch {
      report.stages[key] = { ...report.stages[key], status: 'failed', errorCode: 'INVALID_REPORT' };
      throw new Error(key + ' did not produce a complete JSON report');
    }
  });
  try {
    if (flags.deploy) {
      await stage('binding', async () => {
        const binding = resolveGatewayBinding(flags);
        if (binding.errorCode) throw Object.assign(new Error(binding.detail), { code: binding.errorCode });
        flags.gateway = binding.name;
        flags.gatewayPort = binding.port;
        report.gateway = { name: binding.name, port: binding.port, workspace: gatewayWorkspace() };
      });
    }
    workspace = await mkdtemp(path.join(os.tmpdir(), 'nha-native-integration-'));
    const pack = path.join(workspace, name);
    await sdk('scaffold', ['init', pack, '--name', name, '--display-name', 'Native Echo', '--model', 'fixture-model']);
    report.checks.push('scaffold');
    const installed = await sdk('install', ['install', pack, '--nemoclaw', checkout, '--replace']);
    report.checks.push('install');
    report.agentDir = installed.agentDir;
    report.checkoutRevision = installed.checkoutRevision;
    report.supportedUpstream = installed.supportedUpstream;
    const verification = await sdk('loader', ['verify', '--nemoclaw', checkout, '--name', name]);
    report.loaderAccepted = verification.loaderAccepted === true;
    report.checkoutRevision = verification.checkoutRevision;
    report.supportedUpstream = verification.supportedUpstream;
    report.workload = verification.workload;
    if (!report.loaderAccepted) {
      report.stages.loader = { status: 'failed', errorCode: 'LOADER_REJECTED' };
      throw new Error('The NemoClaw loader rejected agent ' + name);
    }
    report.checks.push('loader-accepted');
    await persist();

    if (flags.deploy) {
      await stage('gateway', async () => {
        await command('gateway', ['openshell', 'gateway', 'select', flags.gateway], { timeoutMs: Math.min(flags.timeoutMs, 60000) });
        assertActive();
        const status = await command('gateway', ['openshell', 'status', ...gatewayArgs(flags)], { timeoutMs: Math.min(flags.timeoutMs, 60000) });
        if (!gatewayStatusIsConnected(status.stdout)) {
          report.stages.gateway = { ...report.stages.gateway, status: 'failed', errorCode: 'GATEWAY_UNHEALTHY' };
          throw new Error('The bound gateway is not connected');
        }
      });
      await stage('native-state', async () => {
        const state = await probeNativeState({ ...report, sandbox: report.sandboxResource }, flags, {
          env: { ...deployEnv(flags), OPENSHELL_WORKSPACE: report.gateway.workspace },
        });
        assertActive();
        report.nativeState = state;
        report.stages['native-state'] = { status: state.status, ownership: state.ownership, ...(state.errorCode ? { errorCode: state.errorCode } : {}) };
        if (state.status !== 'passed') throw new Error('The sandbox name has existing or unverified NemoClaw lifecycle state');
      });
      await stage('preflight', async () => {
        const outcome = await run(['openshell', 'sandbox', 'get', ...gatewayArgs(flags), sandbox], { cwd: checkout, timeoutMs: Math.min(flags.timeoutMs, 30000) });
        assertActive();
        const preflight = classifySandboxPreflightResult({ ...outcome, sandbox });
        // A partial absence response followed by a timeout grants no ownership.
        const truncated = outcome.stdoutTruncated || outcome.stderrTruncated;
        const owned = preflight.ok && !outcome.timedOut && !outcome.errorCode && !outcome.signal && !outcome.cancelled && !truncated;
        report.sandboxResource.ownership = owned ? 'owned' : preflight.preexisting ? 'pre-existing' : 'unknown';
        report.sandboxResource.preflight = owned ? 'absent' : preflight.preexisting ? 'present' : 'failed';
        if (owned) report.nativeState.ownership = 'owned';
        report.stages.preflight = { status: owned ? 'passed' : 'failed', ownership: report.sandboxResource.ownership,
          stdoutTruncated: outcome.stdoutTruncated, stderrTruncated: outcome.stderrTruncated };
        if (!owned) {
          report.stages.preflight.errorCode = outcome.timedOut ? 'TIMEOUT' : outcome.errorCode ?? (outcome.cancelled ? 'INTERRUPTED' : truncated ? 'OUTPUT_LIMIT' : preflight.errorCode ?? 'SANDBOX_PREFLIGHT_FAILED');
          throw new Error(preflight.detail ?? 'Sandbox ownership could not be established');
        }
      });
      // stage() wrote the bound ownership receipt before onboarding can start.
      await stage('onboard', () => command('onboard', [process.execPath, cli, 'onboard', '--name', sandbox, '--agent', name, '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh']));
      report.checks.push('onboard');
      await stage('sandbox', () => command('sandbox', ['openshell', 'sandbox', 'get', ...gatewayArgs(flags), sandbox], { timeoutMs: Math.min(flags.timeoutMs, 30000) }));
      await stage('exec', async () => {
        const task = await command('exec', [process.execPath, cli, sandbox, 'exec', '--', '/usr/local/bin/' + name, 'NHA_NATIVE_OK'], { marker: 'Echo: NHA_NATIVE_OK' });
        report.deploymentVerified = task.markerSeen === true;
        if (!report.deploymentVerified) {
          report.stages.exec = { ...report.stages.exec, status: 'failed', errorCode: 'SMOKE_MISMATCH' };
          throw new Error('The custom harness did not return the expected sandbox marker');
        }
      });
      report.checks.push('sandbox-exec');
    } else {
      for (const key of ['onboard', 'sandbox', 'exec']) report.stages[key] = { status: 'skipped', reason: 'deployment not requested' };
    }
    assertActive();
    report.status = 'passed';
  } catch (error) {
    report.status = interrupted ? 'interrupted' : 'failed';
    report.error = sanitize(error?.message ?? 'native integration failed');
  } finally {
    cleaning = true;
    if (report.status !== 'passed') {
      report.diagnostics = await collectSandboxDiagnostics({ ...report, sandbox: report.sandboxResource }, flags);
      // Diagnostic persistence must never prevent cleanup of an owned resource.
      await persist().catch(() => { report.reportError = 'Could not persist failure diagnostics'; });
    }
    try {
      await cleanupSandbox({ ...report, sandbox: report.sandboxResource }, flags, (argv, options = {}) => run(argv, {
        ...options, env: { ...deployEnv(flags), OPENSHELL_WORKSPACE: report.gateway?.workspace ?? gatewayWorkspace() },
        timeoutMs: Math.min(options.timeoutMs ?? flags.timeoutMs, flags.timeoutMs, 60000),
      }));
      if (!flags.deploy) report.stages.cleanup = { status: 'skipped', reason: 'deployment not requested' };
      if (report.status === 'passed' && flags.deploy && report.stages.cleanup?.status !== 'passed') report.status = 'failed';
    } catch (error) {
      report.stages.cleanup = errorResult(error, 'infrastructure');
      report.status = interrupted ? 'interrupted' : 'failed';
    }
    try { if (workspace) await rm(workspace, { recursive: true, force: true }); }
    catch (error) {
      report.stages.workspaceCleanup = errorResult(error, 'infrastructure');
      report.status = interrupted ? 'interrupted' : 'failed';
    }
    if (interrupted) report.status = 'interrupted';
    report.completedAt = new Date().toISOString();
    try { await persist(); }
    catch {
      report.status = interrupted ? 'interrupted' : 'failed';
      report.reportError = 'Could not persist final report';
    }
    console.log(serializeReport(report));
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
    else if (report.status !== 'passed') process.exitCode = 1;
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(sanitize(error?.message ?? 'Native integration failed'));
    process.exitCode = 1;
  });
}

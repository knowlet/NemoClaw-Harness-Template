// UNOFFICIAL NemoClaw upstream compatibility qualification runner.
// Usage: node scripts/compatibility.mjs --checkout LABEL=PATH [--checkout LABEL=PATH ...] [--expected LABEL=SHA]
//        [--name NAME] [--json REPORT] [--sandbox-prefix PREFIX] [--sandbox-token TOKEN] [--gateway NAME]
//        [--build] [--deploy]
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySandboxPreflightResult } from './lib/sandbox-cleanup.mjs';
import { NATIVE_CONTRACT, VERSION } from '../src/index.mjs';
import { COMPLETE_HOME_CONTRACT, prepareCandidateManifest, loaderStage, qualifyCandidatePersistence } from './lib/candidate-manifest.mjs';
import {
  cleanupOwnedCases,
  cleanupSandbox,
  collectSandboxDiagnostics,
  commandResult,
  deployEnv,
  errorResult,
  gatewayArgs,
  gatewayStatusIsConnected,
  gatewayWorkspace,
  resolveGatewayBinding,
  readStructuredReport,
  probeNativeState,
  run,
  sanitize,
  serializeReport,
  skipped,
  tail,
  terminateActiveCommands,
  writeReportAtomically,
} from './lib/qualification.mjs';
export {
  cleanupOwnedCases,
  cleanupSandbox,
  resolveGatewayBinding,
  run,
  terminateActiveCommands,
  writeReportAtomically,
} from './lib/qualification.mjs';

const SDK_CLI = fileURLToPath(new URL('../bin/nha.mjs', import.meta.url));
const LABEL = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{40}$/;

function usage() {
  console.log([
    'UNOFFICIAL NemoClaw compatibility qualification',
    '',
    'Usage:',
    '  node scripts/compatibility.mjs --checkout LABEL=PATH [--checkout LABEL=PATH ...] [--expected LABEL=SHA]',
    '    [--name NAME] [--json REPORT] [--sandbox-prefix PREFIX] [--sandbox-token TOKEN] [--gateway NAME]',
    '    [--build] [--deploy] [--state-contract LABEL=complete-home-v1]',
    '',
    'A checkout with another revision is allowed only for qualification and is',
    'reported with supportedUpstream: false. --deploy also runs onboarding and',
    'one deterministic sandbox task. Provider credentials are never written to',
    'the report. Without --json, evidence is saved under reports/compatibility-*.json.',
  ].join(String.fromCharCode(10)));
}

function parse(args) {
  const flags = { checkouts: [], expected: new Map(), stateContracts: new Map() };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--help') { flags.help = true; continue; }
    if (value === '--build') { flags.build = true; continue; }
    if (value === '--deploy') { flags.deploy = true; flags.build = true; continue; }
    if (!['--checkout', '--expected', '--state-contract', '--name', '--json', '--sandbox-prefix', '--sandbox-token', '--gateway'].includes(value)) {
      throw new Error('Unknown option: ' + value);
    }
    const next = args[++i];
    if (next === undefined) throw new Error('Missing value for ' + value);
    if (value === '--checkout') {
      const separator = next.indexOf('=');
      if (separator <= 0 || separator === next.length - 1) throw new Error('--checkout must use LABEL=PATH');
      const label = next.slice(0, separator);
      if (!LABEL.test(label)) throw new Error('Invalid checkout label: ' + label);
      flags.checkouts.push({ label, checkout: path.resolve(next.slice(separator + 1)) });
    } else if (value === '--expected') {
      const separator = next.indexOf('=');
      if (separator <= 0 || separator === next.length - 1) throw new Error('--expected must use LABEL=SHA');
      const label = next.slice(0, separator);
      const revision = next.slice(separator + 1);
      if (!LABEL.test(label) || !SHA.test(revision)) throw new Error('Invalid expected revision: ' + next);
      flags.expected.set(label, revision);
    } else if (value === '--state-contract') {
      const [label, contract, extra] = next.split('=');
      if (!LABEL.test(label ?? '') || label === 'pinned' || contract !== COMPLETE_HOME_CONTRACT || extra !== undefined || flags.stateContracts.has(label)) {
        throw new Error('--state-contract requires a unique non-pinned LABEL=complete-home-v1');
      }
      flags.stateContracts.set(label, contract);
    } else if (value === '--name') flags.name = next;
    else if (value === '--json') flags.json = path.resolve(next);
    else if (value === '--sandbox-prefix') flags.sandboxPrefix = next;
    else if (value === '--sandbox-token') flags.sandboxToken = next;
    else {
      if (!NAME.test(next)) throw new Error('Invalid gateway name: ' + next);
      flags.gateway = next;
    }
  }
  if (flags.help) return flags;
  if (flags.checkouts.length === 0) throw new Error('At least one --checkout LABEL=PATH is required');
  if (flags.name !== undefined && !NAME.test(flags.name)) throw new Error('Invalid agent name: ' + flags.name);
  if (flags.sandboxPrefix !== undefined && !NAME.test(flags.sandboxPrefix)) throw new Error('Invalid sandbox prefix: ' + flags.sandboxPrefix);
  if (flags.sandboxToken !== undefined && !TOKEN.test(flags.sandboxToken)) throw new Error('Invalid sandbox token: ' + flags.sandboxToken);
  const labels = new Set();
  for (const item of flags.checkouts) {
    if (labels.has(item.label)) throw new Error('Duplicate checkout label: ' + item.label);
    labels.add(item.label);
  }
  for (const label of flags.stateContracts.keys()) {
    if (!labels.has(label)) throw new Error('State contract has no matching checkout: ' + label);
  }
  for (const label of flags.expected.keys()) {
    if (!labels.has(label)) throw new Error('Expected revision has no matching checkout: ' + label);
  }
  return flags;
}

function summarizeStatus(report) {
  if (report.interrupted) return 'interrupted';
  if (report.error) return 'failed';
  if (report.cases.length === 0) return 'running';
  if (report.cases.some((item) => item.status === 'running')) return 'running';
  return report.cases.every((item) => item.status === 'passed')
    ? 'passed'
    : report.cases.some((item) => item.status === 'blocked') ? 'blocked' : 'failed';
}

function failStage(result, stage, value) {
  result.stages[stage] = value;
  result.status = value.status === 'blocked' ? 'blocked' : 'failed';
  result.failureClass = value.category ?? 'product';
  return result;
}

async function revisionFor(checkout, execute) {
  const result = await execute('checkout', ['git', '-C', checkout, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: 30000 });
  if (result.code !== 0) return { result, revision: null };
  const revision = result.stdout.trim();
  return { result, revision: SHA.test(revision) ? revision : null };
}

async function buildCheckout(result, checkout, execute) {
  const commands = [
    ['root-install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']],
    ['cli-install', ['npm', '--prefix', 'nemoclaw', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']],
    ['cli-build', ['npm', 'run', 'build:cli']],
  ];
  for (const [stage, argv] of commands) {
    const outcome = commandResult(await execute(stage, argv, { cwd: checkout }), 'infrastructure');
    result.stages[stage] = outcome;
    if (outcome.status !== 'passed') return false;
  }
  return true;
}

// NemoClaw caps a routed sandbox name at NAME_MAX_LENGTH characters and rejects
// consecutive hyphens, so onboarding refuses anything longer than this.
const SANDBOX_NAME_MAX = 19;

function sandboxNamePart(value, max, fromEnd = false) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const sliced = fromEnd ? cleaned.slice(-max) : cleaned.slice(0, max);
  return sliced.replace(/^-+|-+$/g, '');
}

function fitSandboxLabel(labelPart, tokenPart) {
  const direct = labelPart + '-' + tokenPart;
  if (direct.length <= SANDBOX_NAME_MAX) return direct;
  const budget = SANDBOX_NAME_MAX - tokenPart.length - 1;
  const trimmed = labelPart.slice(0, Math.max(budget, 0)).replace(/-+$/g, '');
  return trimmed.length >= 3 ? trimmed + '-' + tokenPart : ('nha' + tokenPart).slice(0, SANDBOX_NAME_MAX);
}

/**
 * Build a sandbox name NemoClaw accepts: 1-19 characters, starting with a
 * lowercase letter, lowercase letters, numbers, and single internal hyphens
 * only, ending with a letter or number. The token keeps the run identity, so
 * the name stays unique per run when the prefix does not fit.
 */
export function createSandboxName(prefix, label, token = randomUUID().replaceAll('-', '').slice(0, 12)) {
  const tokenPart = sandboxNamePart(token, 8, true) || 'run';
  const labelPart = sandboxNamePart(label, 12) || 'case';
  const prefixPart = sandboxNamePart(prefix, SANDBOX_NAME_MAX);
  const labeled = fitSandboxLabel(labelPart, tokenPart);
  const prefixed = prefixPart ? prefixPart + '-' + labeled : '';
  return prefixed && prefixed.length <= SANDBOX_NAME_MAX ? prefixed : labeled;
}

function createCase(item, flags, runToken) {
  const expectedRevision = flags.expected.get(item.label) ?? (item.label === 'pinned' ? NATIVE_CONTRACT.revision : null);
  const result = {
    label: item.label,
    checkout: item.checkout,
    expectedRevision,
    actualRevision: null,
    supportedUpstream: null,
    status: 'running',
    failureClass: null,
    stages: {},
    sandbox: flags.deploy ? {
      name: createSandboxName(flags.sandboxPrefix ?? 'nha-compat', item.label, runToken),
      ownership: 'unknown',
      preflight: 'pending',
    } : null,
  };
  return result;
}

async function qualify(result, flags, workspace, record, assertActive) {
  const item = result;
  const expectedRevision = result.expectedRevision;
  const phase = async (key, operation) => {
    assertActive();
    result.activeStage = key;
    result.stages[key] = { status: 'running' };
    await record(result);
    assertActive();
    try {
      const value = await operation();
      assertActive();
      return value;
    } catch (error) {
      if (result.stages[key].status === 'running') result.stages[key] = errorResult(error, 'infrastructure');
      failStage(result, key, result.stages[key]);
      throw error;
    }
  };
  const execute = (key, argv, options) => phase(key, () => run(argv, options));
  // SDK filesystem operations can themselves spawn Git and loader children.
  // Put the CLI and its descendants in the same cancellable process group.
  const sdk = (key, argv) => phase(key, async () => {
    const structured = key === 'loader' ? path.join(workspace, item.label + '-loader.json') : null;
    const outcome = await run([process.execPath, SDK_CLI, 'native', ...argv, ...(structured ? ['--json', structured] : [])], { cwd: workspace });
    assertActive();
    const diagnostic = commandResult(outcome, 'product');
    const failure = () => {
      const detail = /^([A-Z][A-Z_]+):\s*(.+)$/m.exec(outcome.stderr);
      result.stages[key] = { ...diagnostic, errorCode: diagnostic.errorCode ?? detail?.[1] ?? 'COMMAND_FAILED' };
      return Object.assign(new Error(detail?.[2] ?? key + ' command failed'), { code: result.stages[key].errorCode });
    };
    if (outcome.errorCode || outcome.timedOut || outcome.signal) throw failure();
    let report;
    try { report = structured ? await readStructuredReport(structured) : JSON.parse(outcome.stdout); }
    catch {
      if (outcome.code !== 0) throw failure();
      throw Object.assign(new Error(key + ' did not produce a complete JSON report'), { code: 'INVALID_REPORT' });
    }
    if (outcome.code !== 0 && !(key === 'loader' && report.loaderAccepted === false)) throw failure();
    return report;
  });
  const revision = await revisionFor(item.checkout, execute);
  if (!revision.revision) return failStage(result, 'checkout', { ...commandResult(revision.result, 'infrastructure'), ...(revision.result.code === 0 ? { status: 'failed', category: 'infrastructure', errorCode: 'INVALID_REVISION' } : {}) });
  result.actualRevision = revision.revision;
  result.supportedUpstream = revision.revision === NATIVE_CONTRACT.revision;
  result.stages.checkout = { status: 'passed', category: result.supportedUpstream ? 'supported-contract' : 'candidate-contract', revision: revision.revision };
  if (expectedRevision && revision.revision !== expectedRevision) {
    return failStage(result, 'checkout', { status: 'failed', category: 'contract', errorCode: 'PIN_MISMATCH', expectedRevision, actualRevision: revision.revision });
  }
  if (flags.deploy) {
    result.gateway = flags.gatewayError
      ? { name: null, port: null, workspace: gatewayWorkspace() }
      : { name: flags.gateway, port: flags.gatewayPort, workspace: gatewayWorkspace() };
    // Resolve the binding before any gateway command or build: a --gateway that
    // disagrees with NEMOCLAW_GATEWAY_PORT would make the probe, the onboarding,
    // and the cleanup act on different gateways.
    if (flags.gatewayError) {
      return failStage(result, 'gateway', {
        status: 'failed',
        category: 'infrastructure',
        errorCode: flags.gatewayError.errorCode,
        error: sanitize(flags.gatewayError.detail),
      });
    }
  }
  if (flags.build) {
    if (!await buildCheckout(result, item.checkout, execute)) {
      const failedStage = Object.values(result.stages).find((stage) => stage.status && stage.status !== 'passed');
      result.status = failedStage?.status === 'blocked' ? 'blocked' : 'failed';
      result.failureClass = failedStage?.category ?? 'infrastructure';
      return result;
    }
  } else result.stages.build = skipped('build not requested');

  const name = flags.name ?? 'compat-echo';
  const pack = path.join(workspace, item.label, name);
  try {
    await sdk('scaffold', ['init', pack, '--name', name, '--display-name', 'Compatibility Echo', '--model', 'fixture-model']);
    result.stages.scaffold = { status: 'passed' };
  } catch (error) { return failStage(result, 'scaffold', result.stages.scaffold && result.stages.scaffold.status !== 'running' ? result.stages.scaffold : errorResult(error)); }
  const stateContract = flags.stateContracts.get(item.label);
  if (stateContract) {
    const receipt = await phase('manifest', () => prepareCandidateManifest(pack, {
      stateContract, revision: result.actualRevision, nativeContract: NATIVE_CONTRACT,
    }));
    result.manifestQualification = receipt;
    result.stages.manifest = { status: 'passed', ...receipt };
  }
  try {
    const installed = await sdk('install', ['install', pack, '--nemoclaw', item.checkout, '--replace', '--allow-unsupported-upstream']);
    result.stages.install = { status: 'passed', checkoutRevision: installed.checkoutRevision, supportedUpstream: installed.supportedUpstream };
  } catch (error) { return failStage(result, 'install', result.stages.install && result.stages.install.status !== 'running' ? result.stages.install : errorResult(error)); }
  try {
    const verification = await sdk('loader', ['verify', '--nemoclaw', item.checkout, '--name', name, '--allow-unsupported-upstream']);
    result.stages.loader = loaderStage(verification);
    if (result.stages.loader.status !== 'passed') return failStage(result, 'loader', result.stages.loader);
  } catch (error) { return failStage(result, 'loader', result.stages.loader && result.stages.loader.status !== 'running' ? result.stages.loader : errorResult(error)); }

  if (!flags.deploy) {
    result.stages.onboard = skipped('deployment not requested');
    result.stages.exec = skipped('deployment not requested');
    result.status = 'passed';
    return result;
  }
  const cli = path.join(item.checkout, 'bin', 'nemoclaw.js');
  if (flags.gateway) {
    const selected = await execute('gateway', ['openshell', 'gateway', 'select', flags.gateway], { cwd: item.checkout, timeoutMs: 60000 });
    const status = selected.code === 0
      ? await execute('gateway', ['openshell', 'status', ...gatewayArgs(flags)], { cwd: item.checkout, timeoutMs: 60000 })
      : null;
    if (!status) {
      const outcome = commandResult(selected, 'infrastructure');
      return failStage(result, 'gateway', { ...outcome, gateway: flags.gateway, errorCode: outcome.errorCode ?? 'GATEWAY_SELECT_FAILED' });
    }
    if (status.code !== 0 || !gatewayStatusIsConnected(status.stdout)) {
      return failStage(result, 'gateway', {
        status: 'failed',
        category: 'infrastructure',
        errorCode: 'GATEWAY_UNHEALTHY',
        gateway: flags.gateway,
        exitCode: status.code,
        signal: status.signal,
        stdoutTail: tail(status.stdout),
        stderrTail: tail(status.stderr),
      });
    }
    result.stages.gateway = { status: 'passed', category: 'infrastructure', gateway: flags.gateway };
  }
  const sandbox = result.sandbox.name;
  result.nativeState = await phase('native-state', () => probeNativeState(result, flags));
  result.stages['native-state'] = { ...result.nativeState };
  if (result.nativeState.status !== 'passed') return failStage(result, 'native-state', result.stages['native-state']);
  const preflightResult = await execute('preflight', ['openshell', 'sandbox', 'get', ...gatewayArgs(flags), sandbox], { cwd: item.checkout, timeoutMs: 30000 });
  if (preflightResult.timedOut || preflightResult.signal || preflightResult.errorCode || preflightResult.cancelled || preflightResult.stdoutTruncated || preflightResult.stderrTruncated) {
    result.sandbox.ownership = 'unknown';
    result.sandbox.preflight = 'failed';
    return failStage(result, 'preflight', {
      ...commandResult(preflightResult, 'infrastructure'),
      status: preflightResult.timedOut || preflightResult.errorCode ? 'blocked' : 'failed',
      ...(preflightResult.stdoutTruncated || preflightResult.stderrTruncated ? { errorCode: 'OUTPUT_LIMIT' } : preflightResult.cancelled ? { errorCode: 'CANCELLED' } : {}),
      sandbox, ownership: 'unknown',
    });
  }
  const preflight = classifySandboxPreflightResult({ ...preflightResult, sandbox });
  result.stages.preflight = preflight.ok
    ? { status: 'passed', category: 'infrastructure', sandbox, ownership: 'owned', preexisting: false }
    : { status: 'failed', category: 'infrastructure', sandbox, ownership: preflight.preexisting ? 'pre-existing' : 'unknown', preexisting: preflight.preexisting, errorCode: preflight.errorCode, error: sanitize(preflight.detail) };
  result.sandbox.ownership = preflight.ok ? 'owned' : preflight.preexisting ? 'pre-existing' : 'unknown';
  result.sandbox.preflight = preflight.ok ? 'absent' : preflight.preexisting ? 'present' : 'failed';
  if (!preflight.ok) return failStage(result, 'preflight', result.stages.preflight);
  result.nativeState.ownership = 'owned';
  // The ownership receipt reaches disk before onboarding can create anything, so
  // a runner that is killed mid-run still leaves the workflow a list of the
  // resources this run owns.
  result.status = 'running';
  await record(result);

  const onboard = await execute('onboard', [process.execPath, cli, 'onboard', '--name', sandbox, '--agent', name, '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh'], { cwd: item.checkout, env: deployEnv(flags) });
  result.stages.onboard = commandResult(onboard, 'product');
  if (result.stages.onboard.status !== 'passed') {
    result.status = result.stages.onboard.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = result.stages.onboard.category;
    return result;
  }
  // Onboarding received the resolved port, so the sandbox must now exist on the
  // gateway this run owns. Without this check an upstream revision that derived
  // a different gateway would leave the sandbox outside the receipt, and the
  // cleanup would report an already-absent resource while it survived.
  const lookup = await execute('sandbox', ['openshell', 'sandbox', 'get', ...gatewayArgs(flags), sandbox], { cwd: item.checkout, timeoutMs: 30000 });
  result.stages.sandbox = lookup.code === 0
    ? { status: 'passed', category: 'infrastructure', sandbox, gateway: flags.gateway }
    : { status: 'failed', category: 'product', errorCode: 'SANDBOX_GATEWAY_MISMATCH', sandbox, gateway: flags.gateway, exitCode: lookup.code, signal: lookup.signal, stdoutTail: tail(lookup.stdout), stderrTail: tail(lookup.stderr), durationMs: lookup.durationMs };
  if (result.stages.sandbox.status !== 'passed') return failStage(result, 'sandbox', result.stages.sandbox);
  const task = await execute('exec', [process.execPath, cli, sandbox, 'exec', '--', '/usr/local/bin/' + name, 'NHA_COMPAT_OK'], { cwd: item.checkout, env: deployEnv(flags), marker: 'Echo: NHA_COMPAT_OK' });
  result.stages.exec = commandResult(task, 'product');
  if (result.stages.exec.status === 'passed' && !task.markerSeen) {
    result.stages.exec = { status: 'failed', category: 'product', errorCode: 'SMOKE_MISMATCH', stdoutTail: tail(task.stdout), stderrTail: tail(task.stderr), stdoutTruncated: task.stdoutTruncated, stderrTruncated: task.stderrTruncated, durationMs: task.durationMs };
  }
  if (result.stages.exec.status !== 'passed') {
    result.status = result.stages.exec.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = 'product';
    return result;
  }
  if (stateContract && !await qualifyCandidatePersistence({ result, name, cli, execute, env: deployEnv(flags) })) return result;
  result.status = 'passed';
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const flags = parse(args);
  if (flags.help) { usage(); return; }
  const binding = resolveGatewayBinding(flags);
  if (binding.errorCode) flags.gatewayError = binding;
  else { flags.gateway = binding.name; flags.gatewayPort = binding.port; }
  const runToken = flags.sandboxToken ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const reportPath = flags.json ?? path.resolve('reports', 'compatibility-' + randomUUID() + '.json');
  const report = {
    unofficial: true,
    reportPath,
    schemaVersion: 'nemoclaw-compatibility/v1',
    generatedAt: new Date().toISOString(),
    sdkVersion: VERSION,
    nativeContract: { upstream: NATIVE_CONTRACT.upstream, revision: NATIVE_CONTRACT.revision },
    mode: { build: flags.build === true, deploy: flags.deploy === true },
    status: 'running',
    cases: [],
  };
  // Reserve the receipt exclusively before touching any checkout. A stale or
  // concurrent run's evidence must never be overwritten.
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, serializeReport(report) + '\n', { flag: 'wx', mode: 0o600 });
  const persist = () => writeReportAtomically(reportPath, report);
  const record = async (result) => {
    if (!report.cases.includes(result)) report.cases.push(result);
    report.status = summarizeStatus(report);
    try { await persist(); }
    catch (error) { recordError(error); throw error; }
  };
  const recordError = (error) => {
    report.error = { ...errorResult(error, 'infrastructure'), category: 'infrastructure' };
    report.status = summarizeStatus(report);
  };
  let workspace;
  let interrupted;
  let interruptReceipt;
  let cleaning = false;
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    report.interrupted = { signal, at: new Date().toISOString() };
    report.status = 'interrupted';
    // The main path awaits the interrupted operation before cleanup. A signal
    // during cleanup records cancellation without killing the bounded delete.
    if (!cleaning) terminateActiveCommands();
    interruptReceipt = persist().catch(recordError);
  };
  const assertActive = () => {
    if (interrupted) throw Object.assign(new Error('Run interrupted'), { code: 'INTERRUPTED' });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    assertActive();
    workspace = await mkdtemp(path.join(os.tmpdir(), 'nha-compatibility-'));
    assertActive();
    for (const item of flags.checkouts) {
      assertActive();
      const result = createCase(item, flags, runToken);
      try {
        await record(result);
        await qualify(result, flags, workspace, record, assertActive);
      } catch (error) {
        const key = result.activeStage ?? 'qualification';
        if (!['failed', 'blocked'].includes(result.stages[key]?.status)) failStage(result, key, errorResult(error, 'infrastructure'));
        else if (result.status === 'running') failStage(result, key, result.stages[key]);
      } finally {
        // Persist the settled failure before cleanup; both ordinary errors and
        // cancellation follow this one path, so deletion cannot race a child.
        await record(result).catch(recordError);
        cleaning = true;
        if (result.sandbox?.ownership === 'owned' && (result.status !== 'passed' || interrupted)) {
          result.activeStage = 'diagnostics';
          await record(result).catch(recordError);
          try { await collectSandboxDiagnostics(result, flags); }
          catch (error) { result.diagnostics = { error: sanitize(error?.message ?? 'diagnostic collection failed') }; }
          await record(result).catch(recordError);
        }
        try {
          await cleanupSandbox(result, flags, async (argv, options) => {
            result.activeStage = 'cleanup';
            // An evidence disk failure must not strand a resource we own.
            await record(result).catch(recordError);
            return run(argv, {
              ...options, timeoutMs: Math.min(options?.timeoutMs ?? 120000, interrupted ? 60000 : 120000),
            });
          });
        } catch (error) {
          result.stages.cleanup = errorResult(error, 'infrastructure');
          if (result.status === 'passed') failStage(result, 'cleanup', result.stages.cleanup);
        } finally { cleaning = false; }
        delete result.activeStage;
        await record(result).catch(recordError);
      }
      if (interrupted || report.error) break;
    }
  } catch (error) {
    if (error.code !== 'INTERRUPTED') recordError(error);
  } finally {
    cleaning = true;
    try {
      if (workspace) await rm(workspace, { recursive: true, force: true });
    } catch (error) { recordError(error); }
    report.status = summarizeStatus(report);
    await persist().catch(recordError);
    await interruptReceipt;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  report.status = summarizeStatus(report);
  console.log(serializeReport(report));
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  else if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

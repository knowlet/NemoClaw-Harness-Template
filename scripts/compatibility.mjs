// UNOFFICIAL NemoClaw upstream compatibility qualification runner.
// Usage: node scripts/compatibility.mjs --checkout LABEL=PATH [--checkout LABEL=PATH ...] [--expected LABEL=SHA]
//        [--name NAME] [--json REPORT] [--sandbox-prefix PREFIX] [--sandbox-token TOKEN] [--gateway NAME]
//        [--build] [--deploy]
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  classifyDestroyResult,
  classifySandboxPreflightResult,
} from './lib/sandbox-cleanup.mjs';
import {
  NATIVE_CONTRACT,
  VERSION,
  scaffoldNativeAgent,
  installNativeAgent,
  verifyNativeAgent,
} from '../src/index.mjs';

const MAX_CAPTURE_BYTES = 8192;
const MAX_TAIL_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TIMEOUT_TERM_GRACE_MS = 250;
const TIMEOUT_SETTLE_MS = 1000;
// Bounded cleanup after an interrupt: the runner must not hang while the job is
// already being cancelled.
const INTERRUPT_CLEANUP_BUDGET_MS = 120 * 1000;
const INTERRUPT_CLEANUP_COMMAND_MS = 60 * 1000;
const DEFAULT_GATEWAY_PORT = 8080;
const GATEWAY_NAME = /^nemoclaw(?:-(\d+))?$/;
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
    '    [--build] [--deploy]',
    '',
    'A checkout with another revision is allowed only for qualification and is',
    'reported with supportedUpstream: false. --deploy also runs onboarding and',
    'one deterministic sandbox task. Provider credentials are never written to',
    'the report.',
  ].join(String.fromCharCode(10)));
}

function parse(args) {
  const flags = { checkouts: [], expected: new Map() };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--help') { flags.help = true; continue; }
    if (value === '--build') { flags.build = true; continue; }
    if (value === '--deploy') { flags.deploy = true; flags.build = true; continue; }
    if (!['--checkout', '--expected', '--name', '--json', '--sandbox-prefix', '--sandbox-token', '--gateway'].includes(value)) {
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
  for (const label of flags.expected.keys()) {
    if (!labels.has(label)) throw new Error('Expected revision has no matching checkout: ' + label);
  }
  return flags;
}

function secretValues() {
  return Object.entries(process.env)
    .filter(([key, value]) => value && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))
    .map(([, value]) => value)
    .filter((value) => value.length >= 4);
}

function sanitize(value) {
  let text = String(value ?? '');
  for (const secret of secretValues()) text = text.split(secret).join('[REDACTED]');
  return text.replace(/((?:key|token|secret|password|credential)\s*[:=]\s*)[^\s]+/gi, '$1[REDACTED]');
}

function tail(value) {
  const text = sanitize(value);
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= MAX_TAIL_BYTES ? text : bytes.subarray(-MAX_TAIL_BYTES).toString('utf8');
}

function createCapture() {
  return { chunks: [], bytes: 0, truncated: false };
}

function collect(capture, chunk) {
  if (chunk.length >= MAX_CAPTURE_BYTES) {
    capture.chunks = [chunk.subarray(-MAX_CAPTURE_BYTES)];
    capture.bytes = MAX_CAPTURE_BYTES;
    capture.truncated = true;
    return;
  }
  capture.chunks.push(chunk);
  capture.bytes += chunk.length;
  if (capture.bytes <= MAX_CAPTURE_BYTES) return;
  capture.truncated = true;
  let remove = capture.bytes - MAX_CAPTURE_BYTES;
  while (remove > 0) {
    const first = capture.chunks[0];
    if (first.length <= remove) {
      capture.chunks.shift();
      remove -= first.length;
    } else {
      capture.chunks[0] = first.subarray(remove);
      remove = 0;
    }
  }
  capture.bytes = MAX_CAPTURE_BYTES;
}

function captureText(capture) {
  return Buffer.concat(capture.chunks, capture.bytes).toString('utf8');
}

function createMarkerDetector(marker) {
  if (!marker) return null;
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let seen = false;
  return {
    push(chunk) {
      if (seen) return;
      const text = carry + decoder.write(chunk);
      if (text.includes(marker)) {
        seen = true;
        return;
      }
      carry = text.slice(-(marker.length - 1));
    },
    finish() {
      if (!seen) seen = (carry + decoder.end()).includes(marker);
      return seen;
    },
  };
}

function terminateProcess(child, signal) {
  if (!child?.pid) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch { /* use direct-child fallback below */ }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

// Every command runs in its own process group, so the runner can end one that is
// still running when the job is cancelled. Without this a killed runner leaves
// its onboarding child alive.
const activeCommands = new Set();

export function terminateActiveCommands(signal = 'SIGKILL') {
  let terminated = 0;
  for (const child of activeCommands) {
    if (terminateProcess(child, signal)) terminated += 1;
  }
  return terminated;
}

export function run(argv, { cwd, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, marker } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, markerSeen: false, errorCode: error.code ?? 'SPAWN_FAILED', durationMs: Date.now() - started });
      return;
    }
    const stdout = createCapture();
    const stderr = createCapture();
    const detector = createMarkerDetector(marker);
    activeCommands.add(child);
    let settled = false;
    let timedOut = false;
    let timeoutCleanupStarted = false;
    let timer;
    let killTimer;
    let settleTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeCommands.delete(child);
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      resolve({
        ...result,
        stdout: captureText(stdout),
        stderr: captureText(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        markerSeen: detector?.finish() ?? false,
        durationMs: Date.now() - started,
      });
    };
    child.stdout.on('data', (chunk) => { collect(stdout, chunk); detector?.push(chunk); });
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    timer = setTimeout(() => {
      timedOut = true;
      timeoutCleanupStarted = true;
      terminateProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        terminateProcess(child, 'SIGKILL');
        settleTimer = setTimeout(() => {
          // Descendants can retain inherited pipes after the group is gone.
          // Closing our ends bounds settlement independently of those pipes.
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: null, signal: 'SIGKILL', timedOut });
        }, TIMEOUT_SETTLE_MS);
      }, TIMEOUT_TERM_GRACE_MS);
    }, timeoutMs);
    child.once('error', (error) => {
      if (timeoutCleanupStarted) return;
      finish({ code: null, signal: null, timedOut, errorCode: error.code ?? 'SPAWN_FAILED' });
    });
    child.once('close', (code, signal) => {
      if (timeoutCleanupStarted) return;
      finish({ code, signal, timedOut });
    });
  });
}

function classifyError(error) {
  if (error?.code === 'UNSUPPORTED_UPSTREAM' || error?.code === 'PIN_MISMATCH') return 'contract';
  if (['NOT_A_CHECKOUT', 'NOT_BUILT', 'SPAWN_FAILED', 'TIMEOUT'].includes(error?.code)) return 'infrastructure';
  return 'product';
}

function errorResult(error, fallback = 'product') {
  return {
    status: 'failed',
    category: error?.code ? classifyError(error) : fallback,
    errorCode: error?.code ?? 'QUALIFICATION_FAILED',
    error: sanitize(error?.message ?? 'operation failed'),
  };
}

function commandResult(result, category = 'infrastructure') {
  const output = {
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
  };
  if (result.stdout) output.stdoutTail = tail(result.stdout);
  if (result.stderr) output.stderrTail = tail(result.stderr);
  if (result.errorCode) return { status: 'blocked', category, errorCode: result.errorCode, ...output };
  if (result.timedOut) return { status: 'blocked', category, errorCode: 'TIMEOUT', ...output };
  if (result.code !== 0) {
    return { status: 'failed', category, exitCode: result.code, signal: result.signal, ...output };
  }
  return { status: 'passed', exitCode: 0, ...output };
}

function skipped(reason) { return { status: 'skipped', reason }; }

/**
 * Bind every OpenShell command to one named gateway. Without this the probe and
 * the cleanup follow whatever gateway happens to be selected, so a case can
 * inspect one gateway and delete from another. The flag precedes the sandbox
 * name because that is how NemoClaw's own OpenShell adapter builds the command,
 * which keeps the name from being read as part of the flag.
 */
function gatewayArgs(flags) {
  return flags.gateway ? ['-g', flags.gateway] : [];
}

/**
 * Resolve the one gateway binding this run may touch.
 *
 * NemoClaw derives its gateway from NEMOCLAW_GATEWAY_PORT: the default port maps
 * to the bare nemoclaw gateway and any other port to nemoclaw-<port>. A
 * --gateway that disagrees with that derivation would make the ownership probe
 * and the cleanup act on a different gateway than onboarding, and the cleanup
 * would then report an already-absent sandbox while the real one survived. The
 * binding is resolved once, before any gateway command, and onboarding receives
 * the port explicitly.
 */
export function resolveGatewayBinding(flags = {}, env = process.env) {
  const configured = String(env.NEMOCLAW_GATEWAY_PORT ?? '').trim();
  let port;
  if (configured) {
    port = Number(configured);
    if (!/^\d+$/.test(configured) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        errorCode: 'GATEWAY_PORT_INVALID',
        detail: 'NEMOCLAW_GATEWAY_PORT=' + configured + ' is not a usable TCP port',
      };
    }
  } else if (flags.gateway) {
    const match = GATEWAY_NAME.exec(flags.gateway);
    if (!match) {
      return {
        errorCode: 'GATEWAY_BINDING_MISMATCH',
        detail:
          'gateway ' + flags.gateway + ' is outside the NemoClaw gateway namespace, so its port cannot be derived; set NEMOCLAW_GATEWAY_PORT to the port that gateway listens on',
      };
    }
    port = match[1] === undefined ? DEFAULT_GATEWAY_PORT : Number(match[1]);
  } else {
    return {
      errorCode: 'GATEWAY_PORT_UNSET',
      detail:
        'NEMOCLAW_GATEWAY_PORT is not set, so the gateway NemoClaw onboarding would use is unknown; set it, or pass --gateway with a name in the NemoClaw namespace',
    };
  }
  const name = port === DEFAULT_GATEWAY_PORT ? 'nemoclaw' : 'nemoclaw-' + port;
  if (flags.gateway && flags.gateway !== name) {
    return {
      errorCode: 'GATEWAY_BINDING_MISMATCH',
      detail:
        '--gateway ' + flags.gateway + ' does not match NEMOCLAW_GATEWAY_PORT=' + port + ', which resolves to ' + name,
    };
  }
  return { name, port };
}

function gatewayWorkspace(env = process.env) {
  return String(env.OPENSHELL_WORKSPACE ?? '').trim() || 'default';
}

/** The environment onboarding and the sandbox task run with, bound to one port. */
function deployEnv(flags) {
  return flags.gatewayPort
    ? { ...process.env, NEMOCLAW_GATEWAY_PORT: String(flags.gatewayPort) }
    : process.env;
}

function summarizeStatus(report) {
  if (report.interrupted) return 'interrupted';
  if (report.cases.length === 0) return 'running';
  if (report.cases.some((item) => item.status === 'running')) return 'running';
  return report.cases.every((item) => item.status === 'passed')
    ? 'passed'
    : report.cases.some((item) => item.status === 'blocked') ? 'blocked' : 'failed';
}

// The runner persists the report while a case is still running and again from
// the interrupt path, so writes are serialized and each uses its own temporary
// name before the atomic rename.
let reportWriteChain = Promise.resolve();
let reportWriteCounter = 0;

export function writeReportAtomically(target, report) {
  const next = reportWriteChain
    .catch(() => {})
    .then(async () => {
      reportWriteCounter += 1;
      const temporary = target + '.tmp-' + String(process.pid) + '-' + String(reportWriteCounter);
      await writeFile(temporary, JSON.stringify(report, null, 2) + String.fromCharCode(10), { mode: 0o600 });
      await rename(temporary, target);
    });
  reportWriteChain = next.catch(() => {});
  return next;
}

async function assertReportPathFree(target) {
  try {
    await stat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Report already exists: ' + target);
}

/**
 * True only when the table or JSON status output reports a live connection.
 * "Disconnected" contains "connected", so the match requires a boundary.
 */
function gatewayStatusIsConnected(output) {
  const text = String(output ?? '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  return /(?:^|[\s"'])Connected(?:\s|$|[("'])/i.test(text);
}

function failStage(result, stage, value) {
  result.stages[stage] = value;
  result.status = value.status === 'blocked' ? 'blocked' : 'failed';
  result.failureClass = value.category ?? 'product';
  return result;
}

async function revisionFor(checkout) {
  const result = await run(['git', '-C', checkout, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: 30000 });
  if (result.code !== 0) return { result, revision: null };
  const revision = result.stdout.trim();
  return { result, revision: SHA.test(revision) ? revision : null };
}

async function buildCheckout(result, checkout) {
  const commands = [
    ['root-install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']],
    ['cli-install', ['npm', '--prefix', 'nemoclaw', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']],
    ['cli-build', ['npm', 'run', 'build:cli']],
  ];
  for (const [stage, argv] of commands) {
    const outcome = commandResult(await run(argv, { cwd: checkout }), 'infrastructure');
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

async function qualify(item, flags, workspace, runToken, record = async () => {}) {
  const expectedRevision = flags.expected.get(item.label) ?? (item.label === 'pinned' ? NATIVE_CONTRACT.revision : null);
  const result = {
    label: item.label,
    checkout: item.checkout,
    expectedRevision,
    actualRevision: null,
    supportedUpstream: null,
    status: 'blocked',
    failureClass: null,
    stages: {},
    sandbox: flags.deploy ? {
      name: createSandboxName(flags.sandboxPrefix ?? 'nha-compat', item.label, runToken),
      ownership: 'unknown',
      preflight: 'pending',
    } : null,
  };
  const revision = await revisionFor(item.checkout);
  if (!revision.revision) return failStage(result, 'checkout', commandResult(revision.result, 'infrastructure'));
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
    if (!await buildCheckout(result, item.checkout)) {
      const failedStage = Object.values(result.stages).find((stage) => stage.status && stage.status !== 'passed');
      result.status = failedStage?.status === 'blocked' ? 'blocked' : 'failed';
      result.failureClass = failedStage?.category ?? 'infrastructure';
      return result;
    }
  } else result.stages.build = skipped('build not requested');

  const name = flags.name ?? 'compat-echo';
  const pack = path.join(workspace, item.label, name);
  try {
    await scaffoldNativeAgent(pack, { name, displayName: 'Compatibility Echo', model: 'fixture-model' });
    result.stages.scaffold = { status: 'passed' };
  } catch (error) { return failStage(result, 'scaffold', errorResult(error)); }
  try {
    const installed = await installNativeAgent(pack, { nemoclawRoot: item.checkout, replace: true, allowUnsupportedUpstream: true });
    result.stages.install = { status: 'passed', checkoutRevision: installed.checkoutRevision, supportedUpstream: installed.supportedUpstream };
  } catch (error) { return failStage(result, 'install', errorResult(error)); }
  try {
    const verification = await verifyNativeAgent({ nemoclawRoot: item.checkout, name, allowUnsupportedUpstream: true });
    result.stages.loader = { status: verification.loaderAccepted ? 'passed' : 'failed', category: verification.loaderAccepted ? undefined : 'product', loaderAccepted: verification.loaderAccepted, listed: verification.listed, workload: verification.workload, checkoutRevision: verification.checkoutRevision };
    if (!verification.loaderAccepted) return failStage(result, 'loader', result.stages.loader);
  } catch (error) { return failStage(result, 'loader', errorResult(error)); }

  if (!flags.deploy) {
    result.stages.onboard = skipped('deployment not requested');
    result.stages.exec = skipped('deployment not requested');
    result.status = 'passed';
    return result;
  }
  const cli = path.join(item.checkout, 'bin', 'nemoclaw.js');
  if (flags.gateway) {
    const selected = await run(['openshell', 'gateway', 'select', flags.gateway], { cwd: item.checkout, timeoutMs: 60000 });
    const status = selected.code === 0
      ? await run(['openshell', 'status', ...gatewayArgs(flags)], { cwd: item.checkout, timeoutMs: 60000 })
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
  const preflightResult = await run(['openshell', 'sandbox', 'get', ...gatewayArgs(flags), sandbox], { cwd: item.checkout, timeoutMs: 30000 });
  const preflight = classifySandboxPreflightResult({ ...preflightResult, sandbox });
  result.stages.preflight = preflight.ok
    ? { status: 'passed', category: 'infrastructure', sandbox, ownership: 'owned', preexisting: false }
    : { status: 'failed', category: 'infrastructure', sandbox, ownership: preflight.preexisting ? 'pre-existing' : 'unknown', preexisting: preflight.preexisting, errorCode: preflight.errorCode, error: sanitize(preflight.detail) };
  result.sandbox.ownership = preflight.ok ? 'owned' : preflight.preexisting ? 'pre-existing' : 'unknown';
  result.sandbox.preflight = preflight.ok ? 'absent' : preflight.preexisting ? 'present' : 'failed';
  if (!preflight.ok) return failStage(result, 'preflight', result.stages.preflight);
  // The ownership receipt reaches disk before onboarding can create anything, so
  // a runner that is killed mid-run still leaves the workflow a list of the
  // resources this run owns.
  result.status = 'running';
  await record(result);

  const onboard = await run([process.execPath, cli, 'onboard', '--name', sandbox, '--agent', name, '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh'], { cwd: item.checkout, env: deployEnv(flags) });
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
  const lookup = await run(['openshell', 'sandbox', 'get', ...gatewayArgs(flags), sandbox], { cwd: item.checkout, timeoutMs: 30000 });
  result.stages.sandbox = lookup.code === 0
    ? { status: 'passed', category: 'infrastructure', sandbox, gateway: flags.gateway }
    : { status: 'failed', category: 'product', errorCode: 'SANDBOX_GATEWAY_MISMATCH', sandbox, gateway: flags.gateway, exitCode: lookup.code, signal: lookup.signal, stdoutTail: tail(lookup.stdout), stderrTail: tail(lookup.stderr), durationMs: lookup.durationMs };
  if (result.stages.sandbox.status !== 'passed') return failStage(result, 'sandbox', result.stages.sandbox);
  const task = await run([process.execPath, cli, sandbox, 'exec', '--', '/usr/local/bin/' + name, 'NHA_COMPAT_OK'], { cwd: item.checkout, env: deployEnv(flags), marker: 'Echo: NHA_COMPAT_OK' });
  result.stages.exec = commandResult(task, 'product');
  if (result.stages.exec.status === 'passed' && !task.markerSeen) {
    result.stages.exec = { status: 'failed', category: 'product', errorCode: 'SMOKE_MISMATCH', stdoutTail: tail(task.stdout), stderrTail: tail(task.stderr), stdoutTruncated: task.stdoutTruncated, stderrTruncated: task.stderrTruncated, durationMs: task.durationMs };
  }
  if (result.stages.exec.status !== 'passed') {
    result.status = result.stages.exec.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = 'product';
    return result;
  }
  result.status = 'passed';
  return result;
}

export async function cleanupSandbox(result, flags, runCommand = run) {
  if (!flags.deploy) return;
  const sandbox = result.sandbox?.name;
  if (!sandbox || result.sandbox.ownership !== 'owned') {
    result.stages.cleanup = {
      status: 'skipped',
      reason: result.sandbox?.ownership === 'pre-existing'
        ? 'sandbox was pre-existing; ownership was not claimed'
        : 'sandbox ownership was not established',
      sandbox: sandbox ?? null,
      ownership: result.sandbox?.ownership ?? 'unknown',
    };
    return;
  }
  // The interrupt path and the main loop can both reach this sandbox, so a
  // cleanup that already ran or is running is not repeated.
  if (result.stages.cleanup?.status === 'passed' || result.stages.cleanup?.status === 'running') return;
  result.stages.cleanup = { status: 'running', sandbox, ownership: 'owned' };
  const deletion = await runCommand(['openshell', 'sandbox', 'delete', ...gatewayArgs(flags), sandbox], { timeoutMs: 120000 });
  const verdict = classifyDestroyResult({ ...deletion, sandbox });
  const cleanup = commandResult(deletion, 'infrastructure');
  if (verdict.ok) {
    cleanup.status = 'passed';
    cleanup.absent = verdict.absent;
  }
  cleanup.sandbox = sandbox;
  cleanup.ownership = 'owned';
  result.stages.cleanup = cleanup;
  if (result.status === 'passed' && cleanup.status !== 'passed') {
    result.status = cleanup.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = 'infrastructure';
  }
}

/**
 * Delete the sandboxes this run owns, bounded so a cancelled job still exits.
 * Cases that never claimed ownership are left alone.
 */
export async function cleanupOwnedCases(report, flags, runCommand = run) {
  const deadline = Date.now() + INTERRUPT_CLEANUP_BUDGET_MS;
  for (const result of report.cases ?? []) {
    if (result.sandbox?.ownership !== 'owned' || !result.sandbox.name) continue;
    if (result.stages?.cleanup?.status === 'passed') continue;
    if (Date.now() >= deadline) {
      result.stages.cleanup = {
        status: 'blocked',
        category: 'infrastructure',
        errorCode: 'CLEANUP_DEADLINE',
        sandbox: result.sandbox.name,
        ownership: 'owned',
      };
      continue;
    }
    await cleanupSandbox(result, flags, (argv, options = {}) =>
      runCommand(argv, {
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? INTERRUPT_CLEANUP_COMMAND_MS, INTERRUPT_CLEANUP_COMMAND_MS),
      }),
    );
  }
}

export async function main(args = process.argv.slice(2)) {
  const flags = parse(args);
  if (flags.help) { usage(); return; }
  const binding = resolveGatewayBinding(flags);
  if (binding.errorCode) flags.gatewayError = binding;
  else { flags.gateway = binding.name; flags.gatewayPort = binding.port; }
  if (flags.json) await assertReportPathFree(flags.json);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nha-compatibility-'));
  const report = {
    unofficial: true,
    schemaVersion: 'nemoclaw-compatibility/v1',
    generatedAt: new Date().toISOString(),
    sdkVersion: VERSION,
    nativeContract: { upstream: NATIVE_CONTRACT.upstream, revision: NATIVE_CONTRACT.revision },
    mode: { build: flags.build === true, deploy: flags.deploy === true },
    status: 'running',
    cases: [],
  };
  const persist = async () => {
    if (flags.json) await writeReportAtomically(flags.json, report);
  };
  const record = async (result) => {
    if (!report.cases.includes(result)) report.cases.push(result);
    report.status = summarizeStatus(report);
    await persist();
  };
  let interrupt = null;
  let interruptTask = null;
  const onSignal = (signal) => {
    if (interruptTask) return;
    interrupt = signal;
    report.interrupted = { signal, at: new Date().toISOString() };
    report.status = 'interrupted';
    terminateActiveCommands();
    interruptTask = (async () => {
      try {
        await cleanupOwnedCases(report, flags);
      } catch (error) {
        report.cleanupError = sanitize(error?.message ?? 'interrupt cleanup failed');
      }
      await persist().catch(() => {});
    })();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const runToken = flags.sandboxToken ?? randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    for (const item of flags.checkouts) {
      if (interrupt) break;
      const result = await qualify(item, flags, workspace, runToken, record);
      await record(result);
      await cleanupSandbox(result, flags);
      await record(result);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  if (interruptTask) {
    await interruptTask;
    report.status = summarizeStatus(report);
    await persist().catch(() => {});
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = interrupt === 'SIGINT' ? 130 : 143;
    return report;
  }
  report.status = summarizeStatus(report);
  await persist();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

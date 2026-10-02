/** Internal bounded execution and evidence helpers for qualification runners. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { classifyDestroyResult, classifySandboxPreflightResult } from './sandbox-cleanup.mjs';

const MAX_REPORT_BYTES = 2 * 1024 * 1024;

// Loader reports can repeat a long checkout path many times. Read their
// structured channel independently of the rolling diagnostic tail, with a
// fixed bound even if the file grows while it is being read.
export async function readStructuredReport(target) {
  const file = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_REPORT_BYTES) throw new Error('Structured report exceeds its size limit');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await file.close(); }
}


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

function secretValues(env = process.env) {
  return [...new Set([...Object.entries(process.env), ...Object.entries(env)]
    .filter(([key, value]) => value && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))
    .map(([, value]) => String(value))
    .filter((value) => value.length >= 4))];
}

export function sanitize(value, env = process.env) {
  let text = String(value ?? '');
  for (const secret of secretValues(env).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/((?:key|token|secret|password|credential)\s*[:=]\s*)[^\s]+/gi, '$1[REDACTED]');
}

export function tail(value) {
  return boundedText(sanitize(value), MAX_TAIL_BYTES);
}

function boundedText(value, limit) {
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
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
  const bytes = Buffer.from(sanitize(boundedText(Buffer.concat(capture.chunks, capture.bytes), MAX_CAPTURE_BYTES)), 'utf8');
  if (bytes.length > MAX_CAPTURE_BYTES) capture.truncated = true;
  return boundedText(bytes.toString('utf8'), MAX_CAPTURE_BYTES);
}

/**
 * Redact known credentials before retaining a rolling tail. Redacting after
 * truncation can expose the surviving suffix of a credential. Keep only the
 * longest possible partial match between chunks, including UTF-8 boundaries.
 * The mask also handles overlapping values without releasing their fragments.
 */
function createRedactedCapture(capture, secrets) {
  const decoder = new StringDecoder('utf8');
  const keep = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  let pending = '';
  let pendingMask = new Uint8Array();
  let redacting = false;
  const flush = (text, final = false) => {
    text = pending + text;
    const mask = new Uint8Array(text.length);
    mask.set(pendingMask);
    for (const secret of secrets) {
      let position = text.indexOf(secret);
      while (position !== -1) {
        mask.fill(1, position, position + secret.length);
        position = text.indexOf(secret, position + 1);
      }
    }
    let end = final ? text.length : Math.max(0, text.length - keep);
    // Do not split an ordinary surrogate pair when releasing the safe prefix.
    if (end > 0 && end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    const output = [];
    for (let i = 0; i < end;) {
      if (mask[i]) {
        if (!redacting) output.push('[REDACTED]');
        redacting = true;
        i += 1;
      } else {
        redacting = false;
        const start = i++;
        while (i < end && !mask[i]) i += 1;
        output.push(text.slice(start, i));
      }
    }
    if (output.length) collect(capture, Buffer.from(output.join(''), 'utf8'));
    pending = text.slice(end);
    pendingMask = mask.slice(end);
  };
  return {
    push(chunk) { flush(decoder.write(chunk)); },
    finish() { flush(decoder.end(), true); },
  };
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
      carry = marker.length > 1 ? text.slice(-(marker.length - 1)) : '';
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
  for (const command of activeCommands) {
    if (command.cancel(signal)) terminated += 1;
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
    const secrets = secretValues(env);
    const stdoutCapture = createRedactedCapture(stdout, secrets);
    const stderrCapture = createRedactedCapture(stderr, secrets);
    const detector = createMarkerDetector(marker);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let cleanupStarted = false;
    let timer;
    let killTimer;
    let settleTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeCommands.delete(command);
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      stdoutCapture.finish();
      stderrCapture.finish();
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
    const terminate = (signal) => {
      if (settled || cleanupStarted) return false;
      cleanupStarted = true;
      clearTimeout(timer);
      const sent = terminateProcess(child, signal);
      killTimer = setTimeout(() => {
        terminateProcess(child, 'SIGKILL');
        settleTimer = setTimeout(() => {
          // Descendants can retain inherited pipes after the group is gone.
          // Closing our ends bounds settlement independently of those pipes.
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: null, signal: 'SIGKILL', timedOut, ...(cancelled ? { cancelled } : {}) });
        }, TIMEOUT_SETTLE_MS);
      }, TIMEOUT_TERM_GRACE_MS);
      return sent;
    };
    const command = {
      cancel(signal) {
        cancelled = true;
        // A cancellation can arrive during a timeout's TERM grace. Deliver
        // its stronger signal immediately while keeping settlement bounded.
        if (cleanupStarted && !settled) return terminateProcess(child, signal);
        return terminate(signal);
      },
    };
    activeCommands.add(command);
    child.stdout.on('data', (chunk) => { stdoutCapture.push(chunk); detector?.push(chunk); });
    child.stderr.on('data', (chunk) => stderrCapture.push(chunk));
    timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
    }, timeoutMs);
    child.once('error', (error) => {
      if (cleanupStarted) return;
      finish({ code: null, signal: null, timedOut, errorCode: error.code ?? 'SPAWN_FAILED' });
    });
    child.once('close', (code, signal) => {
      if (cleanupStarted) return;
      finish({ code, signal, timedOut });
    });
  });
}

function classifyError(error) {
  if (error?.code === 'UNSUPPORTED_UPSTREAM' || error?.code === 'PIN_MISMATCH') return 'contract';
  if (['NOT_A_CHECKOUT', 'NOT_BUILT', 'SPAWN_FAILED', 'TIMEOUT'].includes(error?.code)) return 'infrastructure';
  return 'product';
}

export function errorResult(error, fallback = 'product') {
  return {
    status: 'failed',
    category: error?.code ? classifyError(error) : fallback,
    errorCode: error?.code ?? 'QUALIFICATION_FAILED',
    error: sanitize(error?.message ?? 'operation failed'),
  };
}

export function commandResult(result, category = 'infrastructure') {
  const output = {
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
  };
  if (result.stdout) output.stdoutTail = tail(result.stdout);
  if (result.stderr) output.stderrTail = tail(result.stderr);
  if (result.errorCode) return { status: 'blocked', category, errorCode: result.errorCode, ...output };
  if (result.timedOut) return { status: 'blocked', category, errorCode: 'TIMEOUT', ...output };
  if (result.cancelled) return { status: 'failed', category, errorCode: 'CANCELLED', ...output };
  if (result.code !== 0 || result.signal) {
    return { status: 'failed', category, exitCode: result.code, signal: result.signal, ...output };
  }
  return { status: 'passed', exitCode: 0, ...output };
}

export function skipped(reason) { return { status: 'skipped', reason }; }

/**
 * Bind every OpenShell command to one named gateway. Without this the probe and
 * the cleanup follow whatever gateway happens to be selected, so a case can
 * inspect one gateway and delete from another. The flag precedes the sandbox
 * name because that is how NemoClaw's own OpenShell adapter builds the command,
 * which keeps the name from being read as part of the flag.
 */
export function gatewayArgs(flags) {
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { errorCode: 'GATEWAY_PORT_INVALID', detail: 'gateway port is not a usable TCP port: ' + String(port) };
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

export function gatewayWorkspace(env = process.env) {
  return String(env.OPENSHELL_WORKSPACE ?? '').trim() || 'default';
}

/** The environment onboarding and the sandbox task run with, bound to one port. */
export function deployEnv(flags) {
  return flags.gatewayPort
    ? { ...process.env, NEMOCLAW_GATEWAY_PORT: String(flags.gatewayPort) }
    : process.env;
}

// The runner persists the report while a case is still running and again from
// the interrupt path, so writes are serialized and each uses its own temporary
// name before the atomic rename.
let reportWriteChain = Promise.resolve();

export function serializeReport(report) {
  return JSON.stringify(report, (_key, value) => typeof value === 'string' ? sanitize(value) : value, 2);
}

export function writeReportAtomically(target, report) {
  // Snapshot now: a queued ownership receipt must not observe later mutation.
  let snapshot;
  try { snapshot = serializeReport(report) + String.fromCharCode(10); }
  catch (error) { return Promise.reject(error); }
  const next = reportWriteChain
    .catch(() => {})
    .then(async () => {
      const temporary = target + '.tmp-' + randomUUID();
      try {
        await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  reportWriteChain = next.catch(() => {});
  return next;
}

export { writeReportAtomically as writeReport };

/**
 * True only when the table or JSON status output reports a live connection.
 * "Disconnected" contains "connected", so the match requires a boundary.
 */
export function gatewayStatusIsConnected(output) {
  const text = String(output ?? '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  return /(?:^|[\s"'])Connected(?:\s|$|[("'])/i.test(text);
}

/** Preserve bounded failure evidence before deleting a sandbox owned by this run. */
export async function collectSandboxDiagnostics(result, flags, runCommand = run) {
  if (!flags.deploy || result.sandbox?.ownership !== 'owned' || !result.sandbox.name) return;
  const binding = result.gateway?.name ?? flags.gateway;
  if (!binding) return;
  const env = {
    ...deployEnv(flags),
    OPENSHELL_WORKSPACE: result.gateway?.workspace ?? gatewayWorkspace(),
  };
  const diagnostics = {};
  for (const [key, argv] of [
    ['sandbox', ['openshell', 'sandbox', 'get', '-g', binding, result.sandbox.name]],
    ['logs', ['openshell', 'logs', '-g', binding, '-n', '50', result.sandbox.name]],
  ]) {
    try {
      diagnostics[key] = commandResult(await runCommand(argv, {
        env, timeoutMs: Math.min(flags.timeoutMs ?? 10000, 10000),
      }));
    } catch (error) { diagnostics[key] = errorResult(error, 'infrastructure'); }
  }
  result.diagnostics = diagnostics;
  return diagnostics;
}

// `list --json` hides pending registrations and independent retained recovery.
// Read the pinned upstream's declared state files without calling recovery APIs:
// those APIs can reconstruct or change the state we are trying to protect.
const NATIVE_STATE_PROBE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [checkout, sandbox] = process.argv.slice(1);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code) => { throw Object.assign(new Error('Native state cannot be qualified'), { code }); };
const read = (target) => {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('NATIVE_STATE_UNSUPPORTED');
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) fail('NATIVE_STATE_INVALID');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length === buffer.length) fail('NATIVE_STATE_OUTPUT_LIMIT');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
};
try {
  const registryPaths = require(path.join(checkout, 'dist/lib/state/registry/persistence.js'));
  const sessionPaths = require(path.join(checkout, 'dist/lib/state/onboard-session.js'));
  const recoveryPaths = require(path.join(checkout, 'dist/lib/state/onboard-session/retained-sandbox-recovery.js'));
  if (typeof sessionPaths.SESSION_DIR !== 'string' || !path.isAbsolute(sessionPaths.SESSION_DIR) || typeof sessionPaths.SESSION_FILE !== 'string' || path.dirname(sessionPaths.SESSION_FILE) !== sessionPaths.SESSION_DIR || typeof recoveryPaths.retainedRebuildSessionFileName !== 'function') fail('NATIVE_STATE_UNSUPPORTED');
  const rebuildName = recoveryPaths.retainedRebuildSessionFileName(sandbox);
  if (typeof rebuildName !== 'string' || !rebuildName || rebuildName === '.' || rebuildName === '..' || path.basename(rebuildName) !== rebuildName) fail('NATIVE_STATE_UNSUPPORTED');
  let rebuild = false;
  try {
    // Any retained target file is prior authority, regardless of its contents.
    if (!fs.lstatSync(path.join(sessionPaths.SESSION_DIR, rebuildName)).isFile()) fail('NATIVE_STATE_INVALID');
    rebuild = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const registry = read(registryPaths.REGISTRY_FILE);
  const session = read(sessionPaths.SESSION_FILE);
  const recovery = read(sessionPaths.RETAINED_SANDBOX_RECOVERY_FILE);
  if (registry !== null && (!object(registry) || !object(registry.sandboxes))) fail('NATIVE_STATE_INVALID');
  if (recovery !== null && (!object(recovery) || recovery.schemaVersion !== 1 || !Array.isArray(recovery.unresolved) || recovery.unresolved.some((item) => !object(item) || typeof item.sandboxName !== 'string'))) fail('NATIVE_STATE_INVALID');
  if (session !== null && (!object(session) || session.version !== 1 || !['in_progress', 'failed', 'complete', 'recovery_required'].includes(session.status) || (session.sandboxName != null && typeof session.sandboxName !== 'string') || (session.cancellationRecovery != null && (!object(session.cancellationRecovery) || typeof session.cancellationRecovery.sandboxName !== 'string')))) fail('NATIVE_STATE_INVALID');
  const retained = recovery?.unresolved ?? [];
  const currentRecovery = session?.cancellationRecovery;
  const recoveryName = currentRecovery?.sandboxName;
  const identityKeys = ['sandboxName', 'sandboxIdentityFingerprint', 'gatewayName', 'gatewayPort', 'lifecycleGeneration', 'createAttemptNonce'];
  const validRecoveryIdentity = currentRecovery && /^[0-9a-f]{62}$/.test(currentRecovery.createAttemptNonce ?? '') && (currentRecovery.sandboxIdentityFingerprint === null || /^[0-9a-f]{64}$/.test(currentRecovery.sandboxIdentityFingerprint ?? '')) && typeof currentRecovery.gatewayName === 'string' && Number.isInteger(currentRecovery.gatewayPort) && currentRecovery.gatewayPort > 0 && currentRecovery.gatewayPort <= 65535 && (currentRecovery.lifecycleGeneration === null || typeof currentRecovery.lifecycleGeneration === 'string');
  const unrelatedRecoveryPreserved = session?.status === 'recovery_required' && recoveryName && recoveryName !== sandbox && validRecoveryIdentity && retained.some((item) => identityKeys.every((key) => item[key] === currentRecovery[key]));
  const sessionProtected = Boolean(session && !unrelatedRecoveryPreserved && (session.cancellationRecovery || session.status === 'recovery_required' || (session.status !== 'complete' && session.resumable !== false)));
  console.log(JSON.stringify({ schemaVersion: 1, ok: true,
    registered: Boolean(registry && (Object.hasOwn(registry.sandboxes, sandbox) || registry.defaultSandbox === sandbox)),
    retained: retained.some((item) => item.sandboxName === sandbox), session: sessionProtected, rebuild,
  }));
} catch (error) {
  const known = ['NATIVE_STATE_UNSUPPORTED', 'NATIVE_STATE_INVALID', 'NATIVE_STATE_OUTPUT_LIMIT'];
  console.log(JSON.stringify({ schemaVersion: 1, ok: false, errorCode: known.includes(error.code) ? error.code : 'NATIVE_STATE_UNVERIFIED' }));
  process.exitCode = 1;
}
`;

export async function probeNativeState(result, flags, { runCommand = run, env = deployEnv(flags) } = {}) {
  const sandbox = result.sandbox?.name;
  const binding = resolveGatewayBinding({ gateway: result.gateway?.name ?? flags.gateway }, env);
  const receipt = {
    schemaVersion: 'nemoclaw-native-state/v1', sandbox,
    home: env.HOME || '/tmp', gateway: binding.name ?? null, gatewayPort: binding.port ?? null,
    workspace: result.gateway?.workspace ?? gatewayWorkspace(env), ownership: 'unknown',
  };
  if (!sandbox || !result.checkout || binding.errorCode) {
    return { ...receipt, status: 'blocked', category: 'infrastructure', errorCode: binding.errorCode ?? 'NATIVE_STATE_UNVERIFIED' };
  }
  try {
    const outcome = await runCommand([process.execPath, '-e', NATIVE_STATE_PROBE, path.resolve(result.checkout), sandbox], {
      cwd: result.checkout, env: { ...env, NEMOCLAW_GATEWAY_PORT: String(binding.port) }, timeoutMs: Math.min(flags.timeoutMs ?? 30000, 30000),
    });
    let projection;
    if (!outcome.timedOut && !outcome.signal && !outcome.errorCode && !outcome.cancelled && !outcome.stdoutTruncated) {
      try { projection = JSON.parse(outcome.stdout); } catch {}
    }
    if (outcome.code !== 0 || projection?.schemaVersion !== 1 || projection?.ok !== true || !['registered', 'retained', 'session', 'rebuild'].every((key) => typeof projection[key] === 'boolean')) {
      return { ...receipt, status: 'blocked', category: 'infrastructure', errorCode: outcome.timedOut ? 'TIMEOUT' : outcome.errorCode ?? projection?.errorCode ?? 'NATIVE_STATE_UNVERIFIED', durationMs: outcome.durationMs };
    }
    const occupied = projection.registered || projection.retained || projection.session || projection.rebuild;
    return {
      ...receipt, status: occupied ? 'failed' : 'passed', ownership: occupied ? 'pre-existing' : 'available',
      registered: projection.registered, retained: projection.retained, session: projection.session, rebuild: projection.rebuild,
      ...(occupied ? { category: 'infrastructure', errorCode: 'NATIVE_STATE_EXISTS' } : {}), durationMs: outcome.durationMs,
    };
  } catch {
    return { ...receipt, status: 'blocked', category: 'infrastructure', errorCode: 'NATIVE_STATE_UNVERIFIED' };
  }
}

async function cleanupNativeSandbox(result, flags, runCommand, env) {
  const sandbox = result.sandbox.name;
  const native = result.nativeState;
  const binding = resolveGatewayBinding({ gateway: result.gateway?.name ?? flags.gateway }, env);
  if (native.schemaVersion !== 'nemoclaw-native-state/v1' || native.sandbox !== sandbox || native.ownership !== 'owned' || !result.checkout || binding.errorCode || native.home !== (env.HOME || '/tmp') || native.gateway !== binding.name || native.gatewayPort !== binding.port || native.workspace !== (result.gateway?.workspace ?? gatewayWorkspace(env))) {
    return { status: 'blocked', category: 'infrastructure', errorCode: 'NATIVE_OWNERSHIP_UNVERIFIED', sandbox, ownership: 'unknown' };
  }
  const boundEnv = { ...env, NEMOCLAW_GATEWAY_PORT: String(binding.port), OPENSHELL_WORKSPACE: native.workspace };
  const deadline = Date.now() + Math.min(flags.timeoutMs ?? 120000, 120000);
  const boundedRun = (argv, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve({ code: null, signal: null, timedOut: true, errorCode: 'CLEANUP_DEADLINE', stdout: '', stderr: '' });
    return runCommand(argv, { ...options, timeoutMs: Math.min(options.timeoutMs ?? remaining, remaining) });
  };
  const before = await probeNativeState(result, flags, { runCommand: boundedRun, env: boundEnv });
  if (before.status === 'blocked') return { ...before, ownership: 'owned', method: 'native' };
  if (before.status === 'passed') {
    const presence = await boundedRun(['openshell', 'sandbox', 'get', '-g', binding.name, sandbox], { env: boundEnv, timeoutMs: 30000 });
    if (!presence.timedOut && !presence.signal && !presence.errorCode && !presence.cancelled && !presence.stdoutTruncated && !presence.stderrTruncated && classifySandboxPreflightResult({ ...presence, sandbox }).ok) {
      return { status: 'passed', sandbox, ownership: 'owned', method: 'native', absent: true, remoteAbsent: true, nativeState: before, skippedDestroy: true };
    }
  }
  // A retained-resource refusal must survive intact. Never fall back to raw
  // mutable-name deletion, --force, or manual registry/recovery-file removal.
  // The native namespace reaches retained-only recovery without the public
  // name-first route's registry recovery gate. Both invoke upstream destroy.
  const deletion = await boundedRun([process.execPath, path.join(result.checkout, 'bin', 'nemoclaw.js'), 'sandbox', 'destroy', sandbox, '--yes', '--no-cleanup-gateway'], {
    cwd: result.checkout, env: boundEnv, timeoutMs: Math.min(flags.timeoutMs ?? 120000, 120000),
  });
  const cleanup = { ...commandResult(deletion, 'infrastructure'), sandbox, ownership: 'owned', method: 'native' };
  if (cleanup.status !== 'passed') return cleanup;
  const presence = await boundedRun(['openshell', 'sandbox', 'get', '-g', binding.name, sandbox], {
    env: boundEnv, timeoutMs: Math.min(flags.timeoutMs ?? 30000, 30000),
  });
  const absent = !presence.timedOut && !presence.signal && !presence.errorCode && !presence.cancelled && !presence.stdoutTruncated && !presence.stderrTruncated && classifySandboxPreflightResult({ ...presence, sandbox }).ok;
  cleanup.remoteAbsent = absent;
  if (!absent) return { ...cleanup, status: 'failed', category: 'infrastructure', errorCode: 'SANDBOX_ABSENCE_UNVERIFIED', verification: commandResult(presence) };
  const state = await probeNativeState(result, flags, { runCommand: boundedRun, env: boundEnv });
  cleanup.nativeState = state;
  if (state.status !== 'passed') return { ...cleanup, status: state.status, category: 'infrastructure', errorCode: 'NATIVE_STATE_REMAINS' };
  return { ...cleanup, absent: true };
}

export async function cleanupSandbox(result, flags, runCommand = run, { env = deployEnv(flags) } = {}) {
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
  if (result.nativeState) {
    result.stages.cleanup = await cleanupNativeSandbox(result, flags, runCommand, env);
    if (result.status === 'passed' && result.stages.cleanup.status !== 'passed') {
      result.status = result.stages.cleanup.status === 'blocked' ? 'blocked' : 'failed';
      result.failureClass = 'infrastructure';
    }
    return;
  }
  const deletion = await runCommand(['openshell', 'sandbox', 'delete', ...gatewayArgs(flags), sandbox], { timeoutMs: 120000 });
  const verdict = classifyDestroyResult({ ...deletion, sandbox });
  const cleanup = commandResult(deletion, 'infrastructure');
  if (verdict.ok && !deletion.timedOut && !deletion.signal && !deletion.errorCode && !deletion.cancelled && (!verdict.absent || (!deletion.stdoutTruncated && !deletion.stderrTruncated))) {
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
      Date.now() >= deadline
        ? Promise.resolve({ code: null, signal: null, timedOut: true, errorCode: 'CLEANUP_DEADLINE', stdout: '', stderr: '' })
        : runCommand(argv, {
          ...options,
          timeoutMs: Math.min(options.timeoutMs ?? INTERRUPT_CLEANUP_COMMAND_MS, INTERRUPT_CLEANUP_COMMAND_MS, Math.max(1, deadline - Date.now())),
        }),
    );
  }
}

// UNOFFICIAL NemoClaw upstream compatibility qualification runner.
// Usage: node scripts/compatibility.mjs --checkout LABEL=PATH [--checkout LABEL=PATH ...] [--expected LABEL=SHA]
//        [--name NAME] [--json REPORT] [--sandbox-prefix PREFIX] [--sandbox-token TOKEN] [--gateway NAME]
//        [--build] [--deploy]
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    let settled = false;
    let timedOut = false;
    let timeoutCleanupStarted = false;
    let timer;
    let killTimer;
    let settleTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
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

export function createSandboxName(prefix, label, token = randomUUID().replaceAll('-', '').slice(0, 12)) {
  const suffix = String(token).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-12) || 'run';
  const normalizedLabel = String(label).replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'case';
  const labelPart = normalizedLabel.length <= 12
    ? normalizedLabel
    : normalizedLabel.slice(0, 7) + '-' + createHash('sha256').update(normalizedLabel).digest('hex').slice(0, 4);
  const normalizedPrefix = String(prefix).replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'nha-compat';
  const prefixBudget = 31 - labelPart.length - suffix.length - 2;
  const prefixPart = prefixBudget > 0 ? normalizedPrefix.slice(0, prefixBudget) : '';
  return [prefixPart, labelPart, suffix].filter(Boolean).join('-');
}

async function qualify(item, flags, workspace, runToken) {
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

  const onboard = await run([process.execPath, cli, 'onboard', '--name', sandbox, '--agent', name, '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh'], { cwd: item.checkout });
  result.stages.onboard = commandResult(onboard, 'product');
  if (result.stages.onboard.status !== 'passed') {
    result.status = result.stages.onboard.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = result.stages.onboard.category;
    return result;
  }
  const task = await run([process.execPath, cli, sandbox, 'exec', '--', '/usr/local/bin/' + name, 'NHA_COMPAT_OK'], { cwd: item.checkout, marker: 'Echo: NHA_COMPAT_OK' });
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

export async function main(args = process.argv.slice(2)) {
  const flags = parse(args);
  if (flags.help) { usage(); return; }
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nha-compatibility-'));
  const report = {
    unofficial: true,
    schemaVersion: 'nemoclaw-compatibility/v1',
    generatedAt: new Date().toISOString(),
    sdkVersion: VERSION,
    nativeContract: { upstream: NATIVE_CONTRACT.upstream, revision: NATIVE_CONTRACT.revision },
    mode: { build: flags.build === true, deploy: flags.deploy === true },
    cases: [],
  };
  const runToken = flags.sandboxToken ?? randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    for (const item of flags.checkouts) {
      const result = await qualify(item, flags, workspace, runToken);
      await cleanupSandbox(result, flags);
      report.cases.push(result);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  report.status = report.cases.every((item) => item.status === 'passed')
    ? 'passed'
    : report.cases.some((item) => item.status === 'blocked') ? 'blocked' : 'failed';
  if (flags.json) await writeFile(flags.json, JSON.stringify(report, null, 2) + String.fromCharCode(10), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

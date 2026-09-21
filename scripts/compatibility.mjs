// UNOFFICIAL NemoClaw upstream compatibility qualification runner.
// Usage: node scripts/compatibility.mjs --checkout LABEL=PATH [--checkout LABEL=PATH ...] [--expected LABEL=SHA]
//        [--name NAME] [--json REPORT] [--build] [--deploy]
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
const LABEL = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{40}$/;

function usage() {
  console.log([
    'UNOFFICIAL NemoClaw compatibility qualification',
    '',
    'Usage:',
    '  node scripts/compatibility.mjs --checkout LABEL=PATH [--checkout LABEL=PATH ...] [--expected LABEL=SHA]',
    '    [--name NAME] [--json REPORT] [--build] [--deploy]',
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
    if (!['--checkout', '--expected', '--name', '--json', '--sandbox-prefix'].includes(value)) {
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
    else flags.sandboxPrefix = next;
  }
  if (flags.help) return flags;
  if (flags.checkouts.length === 0) throw new Error('At least one --checkout LABEL=PATH is required');
  if (flags.name !== undefined && !NAME.test(flags.name)) throw new Error('Invalid agent name: ' + flags.name);
  if (flags.sandboxPrefix !== undefined && !NAME.test(flags.sandboxPrefix)) throw new Error('Invalid sandbox prefix: ' + flags.sandboxPrefix);
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
  return Buffer.byteLength(text) <= MAX_TAIL_BYTES ? text : text.slice(-MAX_TAIL_BYTES);
}

function run(argv, { cwd, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', errorCode: error.code ?? 'SPAWN_FAILED', durationMs: Date.now() - started });
      return;
    }
    const stdout = [];
    const stderr = [];
    const stdoutState = { value: 0 };
    const stderrState = { value: 0 };
    let settled = false;
    let timedOut = false;
    const collect = (target, chunk, current) => {
      if (current.value >= MAX_CAPTURE_BYTES) return;
      const remaining = MAX_CAPTURE_BYTES - current.value;
      const part = chunk.subarray(0, remaining);
      target.push(part);
      current.value += part.length;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, durationMs: Date.now() - started });
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk, stdoutState));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, stderrState));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, signal: null, stdout: '', stderr: '', errorCode: error.code ?? 'SPAWN_FAILED' });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
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
  if (result.errorCode) return { status: 'blocked', category, errorCode: result.errorCode, durationMs: result.durationMs };
  if (result.timedOut) return { status: 'blocked', category, errorCode: 'TIMEOUT', durationMs: result.durationMs };
  if (result.code !== 0) {
    return { status: 'failed', category, exitCode: result.code, signal: result.signal, stderrTail: tail(result.stderr), durationMs: result.durationMs };
  }
  return { status: 'passed', exitCode: 0, durationMs: result.durationMs };
}

function skipped(reason) { return { status: 'skipped', reason }; }

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

async function qualify(item, flags, workspace) {
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
  const sandbox = (flags.sandboxPrefix ?? 'nha-compat') + '-' + item.label;
  const onboard = await run([process.execPath, cli, 'onboard', '--name', sandbox, '--agent', name, '--no-gpu', '--no-sandbox-gpu', '--non-interactive', '--yes', '--yes-i-accept-third-party-software', '--fresh'], { cwd: item.checkout });
  result.stages.onboard = commandResult(onboard, 'product');
  if (result.stages.onboard.status !== 'passed') {
    result.status = result.stages.onboard.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = result.stages.onboard.category;
    return result;
  }
  const task = await run([process.execPath, cli, sandbox, 'exec', '--', '/usr/local/bin/' + name, 'NHA_COMPAT_OK'], { cwd: item.checkout });
  result.stages.exec = commandResult(task, 'product');
  if (result.stages.exec.status === 'passed' && !task.stdout.includes('Echo: NHA_COMPAT_OK')) {
    result.stages.exec = { status: 'failed', category: 'product', errorCode: 'SMOKE_MISMATCH' };
  }
  if (result.stages.exec.status !== 'passed') {
    result.status = result.stages.exec.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = 'product';
    return result;
  }
  result.status = 'passed';
  return result;
}

async function cleanupSandbox(result, item, flags) {
  if (!flags.deploy) return;
  const sandbox = (flags.sandboxPrefix ?? 'nha-compat') + '-' + item.label;
  const cleanup = commandResult(await run(['openshell', 'sandbox', 'delete', sandbox], { timeoutMs: 120000 }), 'infrastructure');
  if (cleanup.status === 'failed' && /not found|does not exist|already absent/i.test(cleanup.stderrTail ?? '')) cleanup.status = 'passed';
  result.stages.cleanup = cleanup;
  if (result.status === 'passed' && cleanup.status !== 'passed') {
    result.status = cleanup.status === 'blocked' ? 'blocked' : 'failed';
    result.failureClass = 'infrastructure';
  }
}

const flags = parse(process.argv.slice(2));
if (flags.help) { usage(); process.exit(0); }
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
try {
  for (const item of flags.checkouts) {
    const result = await qualify(item, flags, workspace);
    await cleanupSandbox(result, item, flags);
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

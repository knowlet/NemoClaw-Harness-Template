/** UNOFFICIAL tests for the NemoClaw compatibility qualification runner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { cleanupSandbox, run, createSandboxName } from '../scripts/compatibility.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function fakeCheckout(root) {
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/agent'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/onboard/workload'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'nemoclaw', version: 'candidate', type: 'commonjs' }) + '\n');
  await writeFile(path.join(root, 'dist/lib/agent/defs.js'), [
    "const path = require('node:path');",
    "exports.listAgents = () => ['compat-echo'];",
    "exports.loadAgent = (name) => ({ dockerfilePath: path.join(process.cwd(), 'agents', name, 'Dockerfile'), runtime: { kind: 'terminal' }, configPaths: { dir: path.join(process.cwd(), 'agents', name) } });",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'dist/lib/agent/onboard.js'), [
    "const path = require('node:path');",
    "exports.getAgentPolicyPath = (agent) => path.join(path.dirname(agent.dockerfilePath), 'policy-additions.yaml');",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'dist/lib/onboard/workload/source.js'), [
    "exports.resolveSandboxWorkloadSource = ({ legacyDockerfilePath }) => ({ kind: 'legacy-dockerfile', dockerfilePath: legacyDockerfilePath, reason: 'candidate-fixture' });",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'bin/nemoclaw.js'), [
    "const action = process.argv[2];",
    "if (action === 'onboard') process.exit(Number(process.env.NHA_ONBOARD_EXIT || '0'));",
    "process.stdout.write('Echo: NHA_COMPAT_OK\\n');",
    '',
  ].join('\n'));
  await chmod(path.join(root, 'bin/nemoclaw.js'), 0o755);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'nha-tests@example.invalid'],
    ['config', 'user.name', 'NHA tests'],
    ['add', '.'],
    ['commit', '-qm', 'candidate fixture'],
  ]) execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

test('fake NemoClaw CLI fixture passes node --check', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const result = spawnSync(process.execPath, ['--check', path.join(checkout, 'bin', 'nemoclaw.js')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function runCompatibility(args, env = {}) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts/compatibility.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function fakeTooling(root) {
  const tools = path.join(root, 'tools');
  await mkdir(tools, { recursive: true });
  await writeFile(path.join(tools, 'npm'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(tools, 'openshell'), [
    '#!/bin/sh',
    'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
    '  if [ "$NHA_EXISTING_SANDBOX" = "$3" ]; then echo "Sandbox $3 is running"; exit 0; fi',
    '  echo "Error: sandbox $3 not found" >&2; exit 1',
    'fi',
    'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
    '  if [ -n "$NHA_DELETE_LOG" ]; then echo "$3" >> "$NHA_DELETE_LOG"; fi',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'));
  await chmod(path.join(tools, 'npm'), 0o755);
  await chmod(path.join(tools, 'openshell'), 0o755);
  return tools;
}

test('compatibility runner qualifies a candidate loader and writes a report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    const revision = await fakeCheckout(checkout);
    const report = path.join(root, 'report.json');
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--expected', 'candidate=' + revision, '--json', report]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'passed');
    assert.equal(parsed.cases.length, 1);
    assert.equal(parsed.cases[0].actualRevision, revision);
    assert.equal(parsed.cases[0].supportedUpstream, false);
    assert.equal(parsed.cases[0].stages.loader.status, 'passed');
    assert.equal(parsed.cases[0].stages.onboard.status, 'skipped');
    assert.equal(JSON.parse(await readFile(report, 'utf8')).status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility runner classifies an unexpected checkout revision as contract failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    const revision = await fakeCheckout(checkout);
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--expected', 'candidate=' + '0'.repeat(40)]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.cases[0].failureClass, 'contract');
    assert.equal(parsed.cases[0].stages.checkout.errorCode, 'PIN_MISMATCH');
    assert.equal(parsed.cases[0].actualRevision, revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PIN_MISMATCH never deletes a sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    const revision = await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--expected', 'candidate=' + '0'.repeat(40),
      '--deploy',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).cases[0].stages.cleanup.status, 'skipped');
    await assert.rejects(() => readFile(deleted, 'utf8'));
    assert.match(revision, /^[0-9a-f]{40}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing sandbox fails preflight without deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const deleted = path.join(root, 'deleted.log');
    const sandbox = createSandboxName('nha-compat', 'candidate', 'testtoken');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NHA_EXISTING_SANDBOX: sandbox, NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.cases[0].stages.preflight.errorCode, 'SANDBOX_EXISTS');
    assert.equal(parsed.cases[0].stages.cleanup.status, 'skipped');
    await assert.rejects(() => readFile(deleted, 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('onboarding failure still cleans up an owned sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NHA_ONBOARD_EXIT: '7', NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.cases[0].stages.onboard.status, 'failed');
    assert.equal(parsed.cases[0].stages.onboard.exitCode, 7);
    assert.equal(parsed.cases[0].sandbox.ownership, 'owned');
    assert.equal(parsed.cases[0].stages.cleanup.status, 'passed');
    assert.equal((await readFile(deleted, 'utf8')).trim(), parsed.cases[0].sandbox.name);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('successful deploy runs preflight, onboard, exec, and cleanup with fake tooling', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const candidate = parsed.cases[0];
    assert.equal(candidate.status, 'passed');
    assert.equal(candidate.sandbox.ownership, 'owned');
    assert.equal(candidate.stages.preflight.status, 'passed');
    assert.equal(candidate.stages.onboard.status, 'passed');
    assert.equal(candidate.stages.exec.status, 'passed');
    assert.equal(candidate.stages.cleanup.status, 'passed');
    assert.equal((await readFile(deleted, 'utf8')).trim(), candidate.sandbox.name);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility sandbox names are unique, bounded, and label scoped', () => {
  const first = createSandboxName('nha-compat', 'candidate', '11111111');
  const second = createSandboxName('nha-compat', 'candidate', '22222222');
  const pinned = createSandboxName('nha-compat-12345678901234567890', 'pinned', '333333333333');
  const candidate = createSandboxName('nha-compat-12345678901234567890', 'candidate', '333333333333');
  assert.notEqual(first, second);
  assert.match(first, /^nha-compat-candidate-[a-z0-9]+$/);
  assert.ok(first.length <= 31);
  assert.notEqual(pinned, candidate);
  assert.match(pinned, /-pinned-333333333333$/);
  assert.match(candidate, /-candidate-333333333333$/);
  assert.ok(pinned.length <= 31);
  assert.ok(candidate.length <= 31);
});

test('run keeps a rolling tail and detects a marker independently of the tail', async () => {
  const script = "process.stdout.write('x'.repeat(10000)); process.stdout.write('Echo: NHA_COMPAT_OK'); process.stdout.write('y'.repeat(10000));";
  const result = await run([process.execPath, '-e', script], { timeoutMs: 2000, marker: 'Echo: NHA_COMPAT_OK' });
  assert.equal(result.code, 0);
  assert.equal(result.markerSeen, true);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdout.length <= 8192);
  assert.equal(result.stdout.includes('Echo: NHA_COMPAT_OK'), false);
});

test('run preserves late stderr diagnostics in the rolling tail', async () => {
  const script = "process.stderr.write('x'.repeat(10000)); process.stderr.write('ACTUAL_BUILD_FAILURE');";
  const result = await run([process.execPath, '-e', script], { timeoutMs: 2000 });
  assert.equal(result.code, 0);
  assert.equal(result.stderrTruncated, true);
  assert.match(result.stderr, /ACTUAL_BUILD_FAILURE/);
});

test('run bounds timeout settlement when a descendant retains stdio', async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    'setInterval(() => {}, 1000);',
  ].join('');
  const started = Date.now();
  const result = await run([process.execPath, '-e', script], { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3000);
});

test('run kills a detached-stdio descendant after the direct child closes on timeout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-timeout-'));
  const pidFile = path.join(root, 'descendant.pid');
  const descendant = [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const parent = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const descendant = spawn(process.execPath, ['-e', " + JSON.stringify(descendant) + "], { stdio: 'ignore' });",
    "writeFileSync(" + JSON.stringify(pidFile) + ", String(descendant.pid));",
    'setInterval(() => {}, 1000);',
  ].join('');
  try {
    const result = await run([process.execPath, '-e', parent], { timeoutMs: 250 });
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    try {
      const pid = Number(await readFile(pidFile, 'utf8'));
      process.kill(pid, 'SIGKILL');
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup never deletes a sandbox without ownership', async () => {
  const result = {
    status: 'failed',
    sandbox: { name: 'nha-compat-existing', ownership: 'unknown' },
    stages: {},
  };
  let calls = 0;
  await cleanupSandbox(result, { deploy: true }, async () => {
    calls += 1;
    return { code: 0, stdout: '', stderr: '', durationMs: 0 };
  });
  assert.equal(calls, 0);
  assert.equal(result.stages.cleanup.status, 'skipped');
  assert.equal(result.stages.cleanup.ownership, 'unknown');
});

test('cleanup deletes a claimed sandbox after onboarding fails', async () => {
  const result = {
    status: 'failed',
    sandbox: { name: 'nha-compat-owned', ownership: 'owned' },
    stages: { onboard: { status: 'failed' } },
  };
  const calls = [];
  await cleanupSandbox(result, { deploy: true }, async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: 'deleted', stderr: '', durationMs: 1, stdoutTruncated: false, stderrTruncated: false };
  });
  assert.deepEqual(calls, [['openshell', 'sandbox', 'delete', 'nha-compat-owned']]);
  assert.equal(result.stages.cleanup.status, 'passed');
  assert.equal(result.stages.cleanup.ownership, 'owned');
});

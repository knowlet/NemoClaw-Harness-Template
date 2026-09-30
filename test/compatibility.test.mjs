/** UNOFFICIAL tests for the NemoClaw compatibility qualification runner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupSandbox,
  createSandboxName,
  main,
  resolveGatewayBinding,
  run,
} from '../scripts/compatibility.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function fakeCheckout(root) {
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/agent'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/onboard/workload'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/state/registry'), { recursive: true });
  await writeFile(path.join(root, 'dist/lib/state/registry/persistence.js'), 'exports.REGISTRY_FILE = ' + JSON.stringify(path.join(root, '.fixture-registry.json')) + ';\n');
  await writeFile(path.join(root, 'dist/lib/state/onboard-session.js'), 'exports.SESSION_FILE = ' + JSON.stringify(path.join(root, '.fixture-session.json')) + '; exports.RETAINED_SANDBOX_RECOVERY_FILE = ' + JSON.stringify(path.join(root, '.fixture-retained.json')) + ';\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'nemoclaw', version: 'candidate', type: 'commonjs' }) + '\n');
  await writeFile(path.join(root, 'dist/lib/agent/defs.js'), [
    "const path = require('node:path');",
    "if (process.env.NHA_LOADER_PID_FILE) require('node:fs').writeFileSync(process.env.NHA_LOADER_PID_FILE, String(process.pid));",
    "if (process.env.NHA_LOADER_HANG) setInterval(() => {}, 1000);",
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
    "const fs = require('node:fs');",
    "const action = process.argv[2];",
    "const registryPath = require('node:path').join(__dirname, '..', '.fixture-registry.json');",
    "const sessionPath = require('node:path').join(__dirname, '..', '.fixture-session.json');",
    "if (process.env.NHA_ENV_LOG) fs.appendFileSync(process.env.NHA_ENV_LOG, action + ' port=' + String(process.env.NEMOCLAW_GATEWAY_PORT) + ' gateway=' + String(process.env.OPENSHELL_GATEWAY) + String.fromCharCode(10));",
    "if (action === 'sandbox' && process.argv[3] === 'destroy') {",
    "  if (process.env.NHA_NATIVE_DESTROY_REFUSE) { process.stderr.write('retained identity cannot be verified'); process.exit(1); }",
    "  if (process.env.NHA_DELETE_EXPECT_SETTLED && JSON.parse(fs.readFileSync(process.env.NHA_DELETE_EXPECT_SETTLED, 'utf8')).cases[0].stages.onboard?.errorCode !== 'INTERRUPTED') process.exit(9);",
    "  const finish = () => { fs.rmSync(registryPath, { force: true }); fs.rmSync(sessionPath, { force: true }); if (process.env.NHA_CREATED_MARKER) fs.rmSync(process.env.NHA_CREATED_MARKER, { force: true }); if (process.env.NHA_DELETE_LOG) fs.appendFileSync(process.env.NHA_DELETE_LOG, process.argv[4] + '\\n'); process.exit(0); };",
    "  if (process.env.NHA_DELETE_PID_FILE) { fs.writeFileSync(process.env.NHA_DELETE_PID_FILE, String(process.pid)); setTimeout(finish, 1000); } else finish();",
    "} else",
    "if (action === 'onboard') {",
    "  const name = process.argv[process.argv.indexOf('--name') + 1];",
    "  fs.writeFileSync(registryPath, JSON.stringify({ sandboxes: { [name]: { name } } }));",
    "  fs.writeFileSync(sessionPath, JSON.stringify({ version: 1, status: 'complete', sandboxName: name, resumable: false }));",
    "  if (process.env.NHA_ONBOARD_PID_FILE) fs.writeFileSync(process.env.NHA_ONBOARD_PID_FILE, String(process.pid));",
    "  if (process.env.NHA_CREATED_MARKER) fs.writeFileSync(process.env.NHA_CREATED_MARKER, String(process.argv[process.argv.indexOf('--name') + 1]));",
    "  if (process.env.NHA_ONBOARD_SLEEP_MS) { setTimeout(() => process.exit(Number(process.env.NHA_ONBOARD_EXIT || '0')), Number(process.env.NHA_ONBOARD_SLEEP_MS)); }",
    "  else { process.exit(Number(process.env.NHA_ONBOARD_EXIT || '0')); }",
    "}",
    "if (process.argv[3] === 'exec' && process.env.NHA_REPORT_FAIL_AFTER_EXEC) { fs.renameSync(process.env.NHA_REPORT_FAIL_AFTER_EXEC, process.env.NHA_REPORT_FAIL_AFTER_EXEC + '.saved'); fs.mkdirSync(process.env.NHA_REPORT_FAIL_AFTER_EXEC); }",
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
  const checkout = args[args.indexOf('--checkout') + 1]?.split('=').slice(1).join('=');
  return spawnSync(process.execPath, [path.join(repo, 'scripts/compatibility.mjs'), ...args], {
    cwd: checkout ? path.dirname(checkout) : repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function waitForFile(target, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(target, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Timed out waiting for ' + target);
}

async function waitForProcessExit(pid, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function fakeTooling(root) {
  const tools = path.join(root, 'tools');
  await mkdir(tools, { recursive: true });
  await writeFile(path.join(tools, 'npm'), '#!/bin/sh\nif [ -n "$NHA_HANG_NPM_ARGS" ] && [ "$NHA_HANG_NPM_ARGS" = "$*" ]; then echo "$$" > "$NHA_TOOL_PID_FILE"; sleep 60; fi\nexit 0\n');
  await writeFile(path.join(tools, 'openshell'), [
    '#!/bin/sh',
    'if [ -n "$NHA_CALL_LOG" ]; then printf "%s\\n" "$*" >> "$NHA_CALL_LOG"; fi',
    'command="$1"',
    'shift',
    'if [ "$1" = "select" ] || [ "$1" = "get" ] || [ "$1" = "delete" ]; then subcommand="$1"; shift; fi',
    'if [ "$1" = "-g" ]; then shift 2; fi',
    'name="$1"',
    'if [ -n "$NHA_HANG_TOOL" ] && [ "$NHA_HANG_TOOL" = "$command $subcommand" ]; then echo "$$" > "$NHA_TOOL_PID_FILE"; sleep 60; fi',
    'if [ "$command" = "gateway" ] && [ "$subcommand" = "select" ]; then',
    '  if [ -n "$NHA_GATEWAY_SELECT_EXIT" ]; then exit "$NHA_GATEWAY_SELECT_EXIT"; fi',
    '  exit 0',
    'fi',
    'if [ "$command" = "status" ]; then',
    '  if [ "$NHA_GATEWAY_STATUS" = "Disconnected" ]; then echo "Status: Disconnected"; else echo "Status: Connected"; fi',
    '  exit 0',
    'fi',
    'if [ "$command" = "sandbox" ] && [ "$subcommand" = "get" ]; then',
    '  if [ "$NHA_EXISTING_SANDBOX" = "$name" ]; then echo "Sandbox $name is running"; exit 0; fi',
    '  if [ -n "$NHA_CREATED_MARKER" ] && [ -f "$NHA_CREATED_MARKER" ] && [ "$(cat "$NHA_CREATED_MARKER")" = "$name" ]; then echo "Sandbox $name is running"; exit 0; fi',
    '  if [ -n "$NHA_PREFLIGHT_SIGNAL" ]; then echo "sandbox $name not found"; kill -TERM "$$"; fi',
    '  echo "Error:   \u00d7 code: \x27Some requested entity was not found\x27, message: \\"sandbox not found\\"" >&2; exit 1',
    'fi',
    'if [ "$command" = "sandbox" ] && [ "$subcommand" = "delete" ]; then',
    '  if [ -n "$NHA_DELETE_EXPECT_SETTLED" ]; then node -e "const r = JSON.parse(require(\'node:fs\').readFileSync(process.env.NHA_DELETE_EXPECT_SETTLED, \'utf8\')); if (r.cases[0].stages.onboard?.errorCode !== \'INTERRUPTED\') process.exit(9);" || exit 9; fi',
    '  if [ -n "$NHA_DELETE_PID_FILE" ]; then echo "$$" > "$NHA_DELETE_PID_FILE"; sleep 1; fi',
    '  if [ -n "$NHA_DELETE_LOG" ]; then echo "$name" >> "$NHA_DELETE_LOG"; fi',
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
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_EXISTING_SANDBOX: sandbox, NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.cases[0].stages.preflight.errorCode, 'SANDBOX_EXISTS');
    assert.equal(parsed.cases[0].stages.cleanup.status, 'skipped');
    await assert.rejects(() => readFile(deleted, 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a signaled preflight cannot claim ownership from partial absence output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const deleted = path.join(root, 'deleted.log');
    const created = path.join(root, 'created.log');
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--deploy', '--gateway', 'nemoclaw'], {
      PATH: tools + ':' + process.env.PATH,
      NEMOCLAW_GATEWAY_PORT: '8080',
      NHA_PREFLIGHT_SIGNAL: '1',
      NHA_DELETE_LOG: deleted,
      NHA_CREATED_MARKER: created,
    });
    assert.equal(result.status, 1, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.equal(candidate.stages.preflight.signal, 'SIGTERM');
    assert.equal(candidate.sandbox.ownership, 'unknown');
    assert.equal(candidate.stages.cleanup.status, 'skipped');
    await assert.rejects(() => readFile(created, 'utf8'));
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
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_ONBOARD_EXIT: '7', NHA_DELETE_LOG: deleted });
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
    const created = path.join(root, 'created.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CREATED_MARKER: created, NHA_DELETE_LOG: deleted });
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

test('gateway binding selects and verifies one managed gateway for every sandbox command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const calls = path.join(root, 'calls.log');
    const deleted = path.join(root, 'deleted.log');
    const created = path.join(root, 'created.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--gateway', 'nemoclaw',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CALL_LOG: calls, NHA_CREATED_MARKER: created, NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 0, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.equal(candidate.stages.gateway.status, 'passed');
    assert.equal(candidate.stages.gateway.gateway, 'nemoclaw');
    assert.equal(candidate.stages.cleanup.status, 'passed');
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split(String.fromCharCode(10)), [
      'gateway select nemoclaw',
      'status -g nemoclaw',
      'sandbox get -g nemoclaw ' + candidate.sandbox.name,
      // The second lookup proves onboarding created the sandbox on this gateway.
      'sandbox get -g nemoclaw ' + candidate.sandbox.name,
      'sandbox get -g nemoclaw ' + candidate.sandbox.name,
    ]);
    assert.equal((await readFile(deleted, 'utf8')).trim(), candidate.sandbox.name);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a disconnected gateway fails before the sandbox probe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const calls = path.join(root, 'calls.log');
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--gateway', 'nemoclaw',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CALL_LOG: calls, NHA_DELETE_LOG: deleted, NHA_GATEWAY_STATUS: 'Disconnected' });
    assert.equal(result.status, 1, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.equal(candidate.stages.gateway.status, 'failed');
    assert.equal(candidate.stages.gateway.errorCode, 'GATEWAY_UNHEALTHY');
    assert.equal(candidate.stages.preflight, undefined);
    assert.equal(candidate.stages.cleanup.status, 'skipped');
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split(String.fromCharCode(10)), [
      'gateway select nemoclaw',
      'status -g nemoclaw',
    ]);
    await assert.rejects(() => readFile(deleted, 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a refused gateway selection stops the case without probing or deleting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const calls = path.join(root, 'calls.log');
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--gateway', 'nemoclaw',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CALL_LOG: calls, NHA_DELETE_LOG: deleted, NHA_GATEWAY_SELECT_EXIT: '1' });
    assert.equal(result.status, 1, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.equal(candidate.stages.gateway.status, 'failed');
    assert.equal(candidate.stages.gateway.errorCode, 'GATEWAY_SELECT_FAILED');
    assert.equal(candidate.stages.cleanup.status, 'skipped');
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split(String.fromCharCode(10)), ['gateway select nemoclaw']);
    await assert.rejects(() => readFile(deleted, 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility rejects an invalid gateway name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--gateway', 'Not A Gateway']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid gateway name/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup deletes a claimed sandbox on the bound gateway', async () => {
  const result = {
    status: 'failed',
    sandbox: { name: 'nha-compat-owned', ownership: 'owned' },
    stages: { onboard: { status: 'failed' } },
  };
  const calls = [];
  await cleanupSandbox(result, { deploy: true, gateway: 'nemoclaw' }, async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: 'deleted', stderr: '', durationMs: 1, stdoutTruncated: false, stderrTruncated: false };
  });
  assert.deepEqual(calls, [['openshell', 'sandbox', 'delete', '-g', 'nemoclaw', 'nha-compat-owned']]);
  assert.equal(result.stages.cleanup.status, 'passed');
});

test('gateway binding follows the NemoClaw port contract', () => {
  assert.deepEqual(resolveGatewayBinding({ gateway: 'nemoclaw' }, { NEMOCLAW_GATEWAY_PORT: '8080' }), { name: 'nemoclaw', port: 8080 });
  assert.deepEqual(resolveGatewayBinding({}, { NEMOCLAW_GATEWAY_PORT: '9090' }), { name: 'nemoclaw-9090', port: 9090 });
  assert.deepEqual(resolveGatewayBinding({ gateway: 'nemoclaw-9090' }, {}), { name: 'nemoclaw-9090', port: 9090 });
  assert.equal(resolveGatewayBinding({ gateway: 'nemoclaw-9090' }, { NEMOCLAW_GATEWAY_PORT: '8080' }).errorCode, 'GATEWAY_BINDING_MISMATCH');
  assert.equal(resolveGatewayBinding({ gateway: 'other-gateway' }, {}).errorCode, 'GATEWAY_BINDING_MISMATCH');
  assert.equal(resolveGatewayBinding({}, {}).errorCode, 'GATEWAY_PORT_UNSET');
  assert.equal(resolveGatewayBinding({}, { NEMOCLAW_GATEWAY_PORT: 'zero' }).errorCode, 'GATEWAY_PORT_INVALID');
});

test('a --gateway that disagrees with the port stops before any gateway command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const calls = path.join(root, 'calls.log');
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--gateway', 'nemoclaw-9090',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CALL_LOG: calls, NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 1, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.equal(candidate.stages.gateway.status, 'failed');
    assert.equal(candidate.stages.gateway.errorCode, 'GATEWAY_BINDING_MISMATCH');
    assert.equal(candidate.gateway.name, null);
    assert.equal(candidate.stages.onboard, undefined);
    assert.equal(candidate.stages.cleanup.status, 'skipped');
    await assert.rejects(() => readFile(calls, 'utf8'));
    await assert.rejects(() => readFile(deleted, 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a deploy run without NEMOCLAW_GATEWAY_PORT is refused before the build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const calls = path.join(root, 'calls.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '', NHA_CALL_LOG: calls });
    assert.equal(result.status, 1, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.equal(candidate.stages.gateway.errorCode, 'GATEWAY_PORT_UNSET');
    assert.equal(candidate.stages.build, undefined);
    assert.equal(candidate.stages.cleanup.status, 'skipped');
    await assert.rejects(() => readFile(calls, 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a non-default port binds the probe, onboarding, and cleanup to one gateway', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const calls = path.join(root, 'calls.log');
    const deleted = path.join(root, 'deleted.log');
    const envLog = path.join(root, 'env.log');
    const created = path.join(root, 'created.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--gateway', 'nemoclaw-9090',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '9090', NHA_CALL_LOG: calls, NHA_CREATED_MARKER: created, NHA_DELETE_LOG: deleted, NHA_ENV_LOG: envLog });
    assert.equal(result.status, 0, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.deepEqual(candidate.gateway, { name: 'nemoclaw-9090', port: 9090, workspace: 'default' });
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split(String.fromCharCode(10)), [
      'gateway select nemoclaw-9090',
      'status -g nemoclaw-9090',
      'sandbox get -g nemoclaw-9090 ' + candidate.sandbox.name,
      'sandbox get -g nemoclaw-9090 ' + candidate.sandbox.name,
      'sandbox get -g nemoclaw-9090 ' + candidate.sandbox.name,
    ]);
    const childEnv = (await readFile(envLog, 'utf8')).trim().split(String.fromCharCode(10));
    assert.equal(childEnv.length, 3);
    assert.match(childEnv[0], /^onboard port=9090 /);
    for (const line of childEnv) assert.match(line, /port=9090 /);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an interrupted run keeps its ownership receipt and cleans up its sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-interrupt-'));
  const checkout = path.join(root, 'NemoClaw');
  const report = path.join(root, 'report.json');
  const calls = path.join(root, 'calls.log');
  const deleted = path.join(root, 'deleted.log');
  const onboardPid = path.join(root, 'onboard.pid');
  let runner;
  try {
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    runner = spawn(process.execPath, [
      path.join(repo, 'scripts/compatibility.mjs'),
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--gateway', 'nemoclaw',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
      '--json', report,
    ], {
      env: {
        ...process.env,
        PATH: tools + ':' + process.env.PATH,
        NEMOCLAW_GATEWAY_PORT: '8080',
        NHA_CALL_LOG: calls,
        NHA_DELETE_LOG: deleted,
        NHA_ONBOARD_PID_FILE: onboardPid,
        NHA_ONBOARD_SLEEP_MS: '60000',
        NHA_DELETE_EXPECT_SETTLED: report,
      },
      stdio: 'ignore',
    });
    await waitForFile(onboardPid);
    const receipt = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(receipt.status, 'running');
    assert.equal(receipt.cases[0].sandbox.ownership, 'owned');
    assert.equal(receipt.cases[0].gateway.name, 'nemoclaw');
    const exited = once(runner, 'exit');
    runner.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 143);
    const final = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(final.status, 'interrupted');
    assert.equal(final.interrupted.signal, 'SIGTERM');
    assert.equal(final.cases[0].stages.cleanup.status, 'passed');
    assert.equal((await readFile(deleted, 'utf8')).trim(), final.cases[0].sandbox.name);
    const pid = Number((await readFile(onboardPid, 'utf8')).trim());
    assert.equal(await waitForProcessExit(pid), true, 'the interrupted onboarding child must not survive');
  } finally {
    if (runner && runner.exitCode === null) runner.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('loader interruption stops its process group and never proceeds to deployment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-loader-interrupt-'));
  const checkout = path.join(root, 'NemoClaw');
  const report = path.join(root, 'report.json');
  const loaderPidFile = path.join(root, 'loader.pid');
  const calls = path.join(root, 'calls.log');
  let runner;
  let loaderPid;
  let exitTimer;
  try {
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    runner = spawn(process.execPath, [path.join(repo, 'scripts/compatibility.mjs'), '--checkout', 'candidate=' + checkout, '--deploy', '--gateway', 'nemoclaw', '--json', report], {
      env: { ...process.env, PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_LOADER_PID_FILE: loaderPidFile, NHA_LOADER_HANG: '1', NHA_CALL_LOG: calls },
      stdio: 'ignore',
    });
    loaderPid = Number(await waitForFile(loaderPidFile));
    const exited = once(runner, 'exit');
    runner.kill('SIGTERM');
    const [code] = await Promise.race([
      exited,
      new Promise((_resolve, reject) => { exitTimer = setTimeout(() => reject(new Error('loader interruption did not settle')), 4000); }),
    ]);
    assert.equal(code, 143);
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(parsed.status, 'interrupted');
    assert.equal(parsed.cases[0].stages.loader.errorCode, 'INTERRUPTED');
    assert.equal(parsed.cases[0].sandbox.ownership, 'unknown');
    await assert.rejects(readFile(calls, 'utf8'), { code: 'ENOENT' });
    assert.equal(await waitForProcessExit(loaderPid), true);
  } finally {
    clearTimeout(exitTimer);
    if (runner && runner.exitCode === null) runner.kill('SIGKILL');
    if (loaderPid) { try { process.kill(loaderPid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace setup failure still writes a structured failed report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-workspace-failure-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const temporaryRoot = path.join(root, 'not-a-directory');
    await writeFile(temporaryRoot, 'fixture');
    const report = path.join(root, 'report.json');
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--json', report], { TMPDIR: temporaryRoot });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.error.errorCode, 'ENOTDIR');
    assert.equal(JSON.parse(result.stdout).status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility main removes its signal listeners after returning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-listeners-'));
  const listeners = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, process.listeners(signal)]));
  const previousExit = process.exitCode;
  const previousLog = console.log;
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    console.log = () => {};
    const report = await main(['--checkout', 'candidate=' + checkout, '--json', path.join(root, 'report.json')]);
    assert.equal(report.status, 'passed');
    for (const [signal, before] of listeners) assert.deepEqual(process.listeners(signal), before);
  } finally {
    console.log = previousLog;
    process.exitCode = previousExit;
    for (const [signal, before] of listeners) {
      for (const listener of process.listeners(signal)) if (!before.includes(listener)) process.removeListener(signal, listener);
    }
    await rm(root, { recursive: true, force: true });
  }
});

for (const phase of ['checkout', 'root-install', 'cli-install', 'cli-build', 'scaffold', 'install', 'gateway', 'preflight', 'exec']) {
  test('interruption during ' + phase + ' persists its phase and stops subsequent work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-phase-interrupt-'));
    const checkout = path.join(root, 'NemoClaw');
    const report = path.join(root, 'report.json');
    const pidFile = path.join(root, 'blocked.pid');
    const created = path.join(root, 'created.log');
    const calls = path.join(root, 'calls.log');
    const deleted = path.join(root, 'deleted.log');
    let runner;
    let blockedPid;
    let exitTimer;
    try {
      await fakeCheckout(checkout);
      const tools = await fakeTooling(root);
      if (phase === 'checkout') {
        await writeFile(path.join(tools, 'git'), '#!/bin/sh\necho "$$" > "$NHA_TOOL_PID_FILE"\nsleep 60\n');
        await chmod(path.join(tools, 'git'), 0o755);
      }
      const preload = path.join(root, 'block-stage.cjs');
      const action = phase === 'scaffold' ? 'init' : phase;
      await writeFile(preload, [
        "const fs = require('node:fs');",
        'const action = ' + JSON.stringify(action) + ';',
        "if ((process.argv[2] === 'native' && process.argv[3] === action) || (action === 'exec' && process.argv[3] === 'exec')) {",
        '  fs.writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid));',
        '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
        '}',
      ].join('\n'));
      runner = spawn(process.execPath, [path.join(repo, 'scripts/compatibility.mjs'), '--checkout', 'candidate=' + checkout, '--checkout', 'later=' + checkout, '--deploy', '--gateway', 'nemoclaw', '--json', report], {
        env: {
          ...process.env, PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080',
          NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --require=' + preload,
          NHA_HANG_TOOL: phase === 'gateway' ? 'gateway select' : phase === 'preflight' ? 'sandbox get' : '',
          NHA_HANG_NPM_ARGS: {
            'root-install': 'ci --ignore-scripts --no-audit --no-fund',
            'cli-install': '--prefix nemoclaw ci --ignore-scripts --no-audit --no-fund',
            'cli-build': 'run build:cli',
          }[phase] ?? '',
          NHA_TOOL_PID_FILE: pidFile, NHA_CREATED_MARKER: created, NHA_CALL_LOG: calls, NHA_DELETE_LOG: deleted,
        },
        stdio: 'ignore',
      });
      blockedPid = Number(await waitForFile(pidFile));
      const progress = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(progress.status, 'running');
      assert.equal(progress.cases[0].activeStage, phase);
      assert.equal(progress.cases[0].stages[phase].status, 'running');
      const exited = once(runner, 'exit');
      runner.kill('SIGTERM');
      const [code] = await Promise.race([
        exited,
        new Promise((_resolve, reject) => { exitTimer = setTimeout(() => reject(new Error(phase + ' interruption did not settle')), 5000); }),
      ]);
      assert.equal(code, 143);
      const parsed = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(parsed.status, 'interrupted');
      assert.equal(parsed.cases.length, 1);
      assert.equal(parsed.cases[0].stages[phase].errorCode, 'INTERRUPTED');
      if (phase === 'exec') {
        assert.equal(parsed.cases[0].stages.cleanup.status, 'passed');
        assert.equal((await readFile(deleted, 'utf8')).trim(), parsed.cases[0].sandbox.name);
      } else {
        assert.equal(parsed.cases[0].sandbox.ownership, 'unknown');
        assert.equal(parsed.cases[0].stages.cleanup.status, 'skipped');
        await assert.rejects(readFile(created, 'utf8'), { code: 'ENOENT' });
        await assert.rejects(readFile(deleted, 'utf8'), { code: 'ENOENT' });
      }
    } finally {
      clearTimeout(exitTimer);
      if (runner && runner.exitCode === null) runner.kill('SIGKILL');
      if (blockedPid) { try { process.kill(-blockedPid, 'SIGKILL'); } catch {} }
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('signals during cleanup let the owned deletion finish exactly once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-cleanup-interrupt-'));
  const checkout = path.join(root, 'NemoClaw');
  const report = path.join(root, 'report.json');
  const deletePid = path.join(root, 'delete.pid');
  const deleted = path.join(root, 'deleted.log');
  let runner;
  try {
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    runner = spawn(process.execPath, [path.join(repo, 'scripts/compatibility.mjs'), '--checkout', 'candidate=' + checkout, '--deploy', '--gateway', 'nemoclaw', '--json', report], {
      env: { ...process.env, PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CREATED_MARKER: path.join(root, 'created'), NHA_DELETE_PID_FILE: deletePid, NHA_DELETE_LOG: deleted },
      stdio: 'ignore',
    });
    await waitForFile(deletePid);
    assert.equal(JSON.parse(await readFile(report, 'utf8')).cases[0].stages.cleanup.status, 'running');
    const exited = once(runner, 'exit');
    runner.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));
    runner.kill('SIGINT');
    const [code] = await exited;
    assert.equal(code, 143);
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(parsed.status, 'interrupted');
    assert.equal(parsed.cases[0].stages.cleanup.status, 'passed');
    assert.deepEqual((await readFile(deleted, 'utf8')).trim().split('\n'), [parsed.cases[0].sandbox.name]);
  } finally {
    if (runner && runner.exitCode === null) runner.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('evidence write failure cannot skip deletion of an owned sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-report-failure-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const report = path.join(root, 'report.json');
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--deploy', '--gateway', 'nemoclaw', '--json', report], {
      PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CREATED_MARKER: path.join(root, 'created'), NHA_DELETE_LOG: deleted, NHA_REPORT_FAIL_AFTER_EXEC: report,
    });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.error.errorCode, 'EISDIR');
    assert.equal(parsed.cases[0].stages.cleanup.status, 'passed');
    assert.equal((await readFile(deleted, 'utf8')).trim(), parsed.cases[0].sandbox.name);
    assert.equal(JSON.parse(await readFile(report + '.saved', 'utf8')).cases[0].sandbox.ownership, 'owned');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deployment without --json still saves a durable ownership report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-default-report-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts/compatibility.mjs'), '--checkout', 'candidate=' + checkout, '--deploy', '--gateway', 'nemoclaw'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_CREATED_MARKER: path.join(root, 'created') },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(path.dirname(parsed.reportPath), path.join(root, 'reports'));
    const receipt = JSON.parse(await readFile(parsed.reportPath, 'utf8'));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.cases[0].sandbox.ownership, 'owned');
    assert.equal(receipt.cases[0].stages.cleanup.status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a sandbox that onboarding did not create on the bound gateway fails the case', async () => {
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
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 1, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.equal(candidate.stages.onboard.status, 'passed');
    assert.equal(candidate.stages.sandbox.status, 'failed');
    assert.equal(candidate.stages.sandbox.errorCode, 'SANDBOX_GATEWAY_MISMATCH');
    assert.equal(candidate.stages.sandbox.gateway, 'nemoclaw');
    assert.equal(candidate.stages.exec, undefined);
    assert.equal(candidate.failureClass, 'product');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a non-default workspace is recorded in the gateway receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    await fakeCheckout(checkout);
    const tools = await fakeTooling(root);
    const created = path.join(root, 'created.log');
    const deleted = path.join(root, 'deleted.log');
    const result = runCompatibility([
      '--checkout', 'candidate=' + checkout,
      '--deploy',
      '--sandbox-prefix', 'nha-compat',
      '--sandbox-token', 'testtoken',
    ], { PATH: tools + ':' + process.env.PATH, NEMOCLAW_GATEWAY_PORT: '8080', OPENSHELL_WORKSPACE: 'ci-eu', NHA_CREATED_MARKER: created, NHA_DELETE_LOG: deleted });
    assert.equal(result.status, 0, result.stderr);
    const candidate = JSON.parse(result.stdout).cases[0];
    assert.deepEqual(candidate.gateway, { name: 'nemoclaw', port: 8080, workspace: 'ci-eu' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// NemoClaw caps a routed sandbox name at 19 characters, requires a leading
// lowercase letter and a trailing letter or number, and rejects consecutive
// hyphens. Onboarding refuses a name that breaks any of those rules.
test('compatibility sandbox names satisfy the NemoClaw routed-name contract', () => {
  const workflowToken = '35588915776-1';
  const names = [
    createSandboxName('nha-compat-35588915776', 'pinned', workflowToken),
    createSandboxName('nha-compat-35588915776', 'candidate', workflowToken),
    createSandboxName('nha-compat', 'candidate', '11111111'),
    createSandboxName('nha-compat', 'candidate', '22222222'),
    createSandboxName('nha-compat-12345678901234567890', 'pinned', '333333333333'),
    createSandboxName('x', 'case', '9'),
    createSandboxName('', '', ''),
  ];
  for (const name of names) {
    assert.ok(name.length >= 1 && name.length <= 19, name);
    assert.match(name, /^[a-z][a-z0-9-]*[a-z0-9]$/, name);
    assert.doesNotMatch(name, /--/, name);
  }
  assert.equal(names[0], 'pinned-915776-1');
  assert.equal(names[1], 'candidate-915776-1');
  assert.notEqual(names[2], names[3]);
  assert.notEqual(names[0], names[1]);
  assert.match(names[4], /^pinned-/);
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

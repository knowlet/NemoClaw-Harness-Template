/** UNOFFICIAL native qualification runner tests using isolated CLI fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_CONTRACT } from '../src/index.mjs';

const runnerPath = fileURLToPath(new URL('../scripts/integration/native-agent.mjs', import.meta.url));
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

async function executable(target, source) {
  await writeFile(target, '#!' + process.execPath + '\n' + source + '\n');
  await chmod(target, 0o755);
}

async function fixture(t, overrides = {}, { deepCheckout = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-native-integration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, ...(deepCheckout ? Array(31).fill('n'.repeat(60)) : []), 'NemoClaw');
  const tooling = path.join(root, 'tools');
  const registry = path.join(root, 'registry.json');
  const retained = path.join(root, 'retained.json');
  const session = path.join(root, 'session.json');
  for (const dir of ['agents', 'bin', 'dist/lib/agent', 'dist/lib/onboard/workload', 'dist/lib/state/registry']) {
    await mkdir(path.join(checkout, dir), { recursive: true });
  }
  await mkdir(tooling);
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ name: 'nemoclaw', type: 'commonjs' }));
  await writeFile(path.join(checkout, 'dist/lib/agent/defs.js'), [
    "const path = require('node:path');",
    "exports.listAgents = () => ['native-echo'];",
    "exports.loadAgent = (name) => ({ dockerfilePath: path.join(process.cwd(), 'agents', name, 'Dockerfile'), runtime: { kind: 'terminal' }, configPaths: { dir: path.join(process.cwd(), 'agents', name) } });",
  ].join('\n'));
  await writeFile(path.join(checkout, 'dist/lib/agent/onboard.js'), "exports.getAgentPolicyPath = (agent) => require('node:path').join(require('node:path').dirname(agent.dockerfilePath), 'policy-additions.yaml');\n");
  await writeFile(path.join(checkout, 'dist/lib/onboard/workload/source.js'), "exports.resolveSandboxWorkloadSource = ({ legacyDockerfilePath }) => ({ kind: 'legacy-dockerfile', dockerfilePath: legacyDockerfilePath, reason: 'fixture' });\n");
  await writeFile(path.join(checkout, 'dist/lib/state/registry/persistence.js'), 'exports.REGISTRY_FILE = ' + JSON.stringify(registry) + ';\n');
  await writeFile(path.join(checkout, 'dist/lib/state/onboard-session.js'), 'exports.SESSION_FILE = ' + JSON.stringify(session) + ';\nexports.RETAINED_SANDBOX_RECOVERY_FILE = ' + JSON.stringify(retained) + ';\n');
  if (overrides.NHA_NATIVE_TEST_RETAINED) {
    await writeFile(retained, JSON.stringify({ schemaVersion: 1, unresolved: [{ sandboxName: overrides.NHA_NATIVE_TEST_RETAINED }] }));
  }
  if (overrides.NHA_NATIVE_TEST_REGISTERED) {
    const name = overrides.NHA_NATIVE_TEST_REGISTERED;
    await writeFile(registry, JSON.stringify({ sandboxes: { [name]: { name } } }));
  }
  if (overrides.NHA_NATIVE_TEST_PRIOR_SESSION) await writeFile(session, overrides.NHA_NATIVE_TEST_PRIOR_SESSION);
  execFileSync(realGit, ['-C', checkout, 'init', '-q'], { stdio: 'pipe' });
  await executable(path.join(tooling, 'git'), [
    "const { spawnSync } = require('node:child_process');",
    'const args = process.argv.slice(2);',
    "if (args.slice(-3).join(' ') === 'rev-parse --verify HEAD') {",
    "  process.stdout.write((process.env.NHA_NATIVE_TEST_REVISION || " + JSON.stringify(NATIVE_CONTRACT.revision) + ") + '\\n');",
    '} else {',
    '  const result = spawnSync(' + JSON.stringify(realGit) + ", args, { stdio: 'inherit' });",
    '  process.exitCode = result.status ?? 1;',
    '}',
  ].join('\n'));
  await writeFile(path.join(checkout, 'bin/nemoclaw.js'), [
    "const fs = require('node:fs');",
    'const action = process.argv[2];',
    "fs.appendFileSync(process.env.NHA_NATIVE_TEST_ENV_LOG, JSON.stringify({ action, operation: process.argv[3], port: process.env.NEMOCLAW_GATEWAY_PORT, gateway: process.env.OPENSHELL_GATEWAY, workspace: process.env.OPENSHELL_WORKSPACE }) + '\\n');",
    "if (action === 'onboard') {",
    "  fs.writeFileSync(process.env.NHA_NATIVE_TEST_PID, String(process.pid));",
    "  const name = process.argv[process.argv.indexOf('--name') + 1];",
    "  fs.writeFileSync(process.env.NHA_NATIVE_TEST_CREATED, name);",
    "  fs.writeFileSync(process.env.NHA_NATIVE_TEST_REGISTRY, JSON.stringify({ sandboxes: { [name]: { name } } }));",
    "  fs.writeFileSync(process.env.NHA_NATIVE_TEST_SESSION, JSON.stringify({ version: 1, status: 'complete', sandboxName: name, resumable: false, cancellationRecovery: null }));",
    "  if (process.env.NHA_NATIVE_TEST_EMIT_SECRET) process.stderr.write('provider response ' + process.env.NVIDIA_API_KEY + '\\n');",
    "  if (process.env.NHA_NATIVE_TEST_HANG) setInterval(() => {}, 1000);",
    "  else process.exitCode = Number(process.env.NHA_NATIVE_TEST_ONBOARD_EXIT || '0');",
    "} else if (process.argv[3] === 'destroy') {",
    "  const destroyedName = action === 'sandbox' ? process.argv[4] : action;",
    "  if (process.argv.includes('--force') || !process.argv.includes('--no-cleanup-gateway')) { console.error('unsafe native destroy flags'); process.exit(9); }",
    "  if (process.env.NHA_NATIVE_TEST_REQUIRE_EXIT && fs.existsSync(process.env.NHA_NATIVE_TEST_PID)) {",
    "    const pid = Number(fs.readFileSync(process.env.NHA_NATIVE_TEST_PID, 'utf8'));",
    "    try { process.kill(pid, 0); console.error('onboarding is still running during cleanup'); process.exit(8); }",
    "    catch (error) { if (error.code !== 'ESRCH') throw error; }",
    '  }',
    "  fs.appendFileSync(process.env.NHA_NATIVE_TEST_DELETE_LOG, destroyedName + '\\n');",
    "  if (process.env.NHA_NATIVE_TEST_DELETE_FAIL) { console.error('native lifecycle deletion refused'); process.exit(7); }",
    "  if (!process.env.NHA_NATIVE_TEST_DESTROY_LEAVES_RUNTIME) fs.rmSync(process.env.NHA_NATIVE_TEST_CREATED, { force: true });",
    "  if (!process.env.NHA_NATIVE_TEST_DESTROY_LEAVES_NATIVE) {",
    "    fs.rmSync(process.env.NHA_NATIVE_TEST_REGISTRY, { force: true });",
    "    fs.rmSync(process.env.NHA_NATIVE_TEST_SESSION, { force: true });",
    "  }",
    "  console.log('Sandbox ' + destroyedName + ' destroyed');",
    "} else process.stdout.write('Echo: NHA_NATIVE_OK\\n');",
  ].join('\n'));
  await executable(path.join(tooling, 'openshell'), [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.NHA_NATIVE_TEST_CALL_LOG, args.join(' ') + '\\n');",
    "const name = args.at(-1);",
    "if (args[0] === 'gateway' && args[1] === 'select') process.exit(0);",
    "if (args[0] === 'status') { console.log('Status: Connected'); process.exit(0); }",
    "if (args[0] === 'sandbox' && args[1] === 'get') {",
    "  const created = fs.existsSync(process.env.NHA_NATIVE_TEST_CREATED) && fs.readFileSync(process.env.NHA_NATIVE_TEST_CREATED, 'utf8') === name;",
    "  if (process.env.NHA_NATIVE_TEST_EXISTING === name || created) { console.log('Sandbox ' + name + ' is running'); process.exit(0); }",
    "  if (process.env.NHA_NATIVE_TEST_TRUNCATED_PREFLIGHT) fs.writeSync(2, 'gateway response incomplete\\n' + ' '.repeat(20000) + '\\n');",
    "  console.error('sandbox ' + name + ' not found'); process.exit(1);",
    '}',
    "if (args[0] === 'sandbox' && args[1] === 'delete') {",
    "  console.error('raw mutable-name deletion must not bypass the native lifecycle'); process.exit(9);",
    '}',
    'process.exit(1);',
  ].join('\n'));
  const report = path.join(root, 'report.json');
  const deleted = path.join(root, 'deleted.log');
  const calls = path.join(root, 'calls.log');
  const onboardPid = path.join(root, 'onboard.pid');
  const envLog = path.join(root, 'env.log');
  return {
    root, checkout, report, deleted, calls, onboardPid, envLog, registry, retained, session,
    args: [runnerPath, '--nemoclaw', checkout, '--name', 'native-echo', '--sandbox', 'native-test', '--deploy', '--gateway', 'nemoclaw', '--json', report],
    env: {
      ...process.env, PATH: tooling + path.delimiter + process.env.PATH,
      NEMOCLAW_GATEWAY_PORT: '8080', OPENSHELL_WORKSPACE: 'native-fixture',
      NHA_NATIVE_TEST_DELETE_LOG: deleted, NHA_NATIVE_TEST_CALL_LOG: calls,
      NHA_NATIVE_TEST_PID: onboardPid, NHA_NATIVE_TEST_ENV_LOG: envLog,
      NHA_NATIVE_TEST_REGISTRY: registry, NHA_NATIVE_TEST_SESSION: session,
      NHA_NATIVE_TEST_CREATED: path.join(root, 'created'), ...overrides,
    },
  };
}

function runNative(value, args = []) {
  const result = spawnSync(process.execPath, [...value.args, ...args], { env: value.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

async function readReport(value, result) {
  const saved = JSON.parse(await readFile(value.report, 'utf8'));
  assert.deepEqual(JSON.parse(result.stdout), saved, result.stderr);
  return saved;
}

async function waitForFile(target) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { return await readFile(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + target);
}

test('native deploy records every stage, binds gateway commands, and cleans up', async (t) => {
  const value = await fixture(t);
  const result = runNative(value);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = await readReport(value, result);
  assert.equal(report.status, 'passed');
  assert.equal(report.loaderAccepted, true);
  assert.equal(report.deploymentVerified, true);
  assert.equal(report.checkoutRevision, NATIVE_CONTRACT.revision);
  assert.equal(report.supportedUpstream, true);
  assert.equal(report.sandbox, 'native-test');
  assert.deepEqual(report.sandboxResource, { name: 'native-test', ownership: 'owned', preflight: 'absent' });
  assert.deepEqual(report.gateway, { name: 'nemoclaw', port: 8080, workspace: 'native-fixture' });
  for (const stage of ['scaffold', 'install', 'loader', 'binding', 'gateway', 'native-state', 'preflight', 'onboard', 'sandbox', 'exec', 'cleanup']) {
    assert.equal(report.stages[stage].status, 'passed', stage);
  }
  assert.deepEqual((await readFile(value.calls, 'utf8')).trim().split('\n'), [
    'gateway select nemoclaw', 'status -g nemoclaw',
    'sandbox get -g nemoclaw native-test', 'sandbox get -g nemoclaw native-test',
    'sandbox get -g nemoclaw native-test',
  ]);
  assert.equal((await readFile(value.deleted, 'utf8')).trim(), 'native-test');
  const childEnvs = (await readFile(value.envLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(childEnvs.map(({ action }) => action), ['onboard', 'native-test', 'sandbox']);
  assert.equal(childEnvs.at(-1).operation, 'destroy');
  for (const child of childEnvs) {
    assert.equal(child.port, '8080');
    assert.equal(child.workspace, 'native-fixture');
  }
});

test('native loader reads complete verification evidence beyond the diagnostic output tail', async (t) => {
  const value = await fixture(t, {}, { deepCheckout: true });
  value.args = value.args.filter((arg) => arg !== '--deploy');
  assert.ok(value.checkout.length > 1900);
  const result = runNative(value);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = await readReport(value, result);
  assert.equal(report.status, 'passed');
  assert.equal(report.loaderAccepted, true);
  assert.equal(report.deploymentVerified, false);
  assert.equal(report.stages.loader.status, 'passed');
  assert.equal(report.stages.loader.stdoutTruncated, true);
  assert.equal(report.stages.onboard.status, 'skipped');
  assert.equal(report.stages.cleanup.status, 'skipped');
});

test('native preflight cannot claim ownership from truncated absence evidence', async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_TRUNCATED_PREFLIGHT: '1' });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.status, 'failed');
  assert.equal(report.sandboxResource.ownership, 'unknown');
  assert.equal(report.nativeState.ownership, 'available');
  assert.equal(report.stages.preflight.errorCode, 'OUTPUT_LIMIT');
  assert.equal(report.stages.preflight.stderrTruncated, true);
  assert.equal(report.stages.onboard, undefined);
  assert.equal(report.stages.cleanup.status, 'skipped');
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
});

test('native onboarding failure persists evidence and cleans up its owned sandbox', async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_ONBOARD_EXIT: '7' });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.status, 'failed');
  assert.equal(report.loaderAccepted, true);
  assert.equal(report.deploymentVerified, false);
  assert.equal(report.stages.onboard.status, 'failed');
  assert.equal(report.stages.onboard.exitCode, 7);
  assert.equal(report.diagnostics.sandbox.status, 'passed');
  assert.equal(report.diagnostics.logs.status, 'failed');
  assert.equal(report.stages.cleanup.status, 'passed');
  assert.equal((await readFile(value.deleted, 'utf8')).trim(), 'native-test');
});

test('native onboarding deadline redacts provider credentials in console and persisted evidence', async (t) => {
  const secret = 'fixture-provider-key-native-987654321';
  const value = await fixture(t, { NHA_NATIVE_TEST_HANG: '1', NHA_NATIVE_TEST_EMIT_SECRET: '1', NVIDIA_API_KEY: secret });
  const result = runNative(value, ['--timeout-ms', '2500']);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.status, 'failed');
  assert.equal(report.stages.onboard.errorCode, 'TIMEOUT');
  assert.equal(report.stages.cleanup.status, 'passed');
  const outputs = result.stdout + result.stderr + await readFile(value.report, 'utf8');
  assert.ok(!outputs.includes(secret));
  assert.match(outputs, /\[REDACTED\]/);
  const pid = Number(await readFile(value.onboardPid, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('native SIGTERM keeps a durable ownership receipt and terminates onboarding before cleanup', { timeout: 30000 }, async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_HANG: '1', NHA_NATIVE_TEST_REQUIRE_EXIT: '1' });
  const runner = spawn(process.execPath, value.args, { env: value.env, stdio: 'ignore' });
  const exited = once(runner, 'exit');
  t.after(() => { if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL'); });
  const pid = Number(await waitForFile(value.onboardPid));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const receipt = JSON.parse(await readFile(value.report, 'utf8'));
  assert.equal(receipt.status, 'running');
  assert.equal(receipt.sandboxResource.ownership, 'owned');
  assert.equal(receipt.gateway.name, 'nemoclaw');
  runner.kill('SIGTERM');
  const [exitCode] = await exited;
  assert.equal(exitCode, 143);
  const report = JSON.parse(await readFile(value.report, 'utf8'));
  assert.equal(report.status, 'interrupted');
  assert.equal(report.interrupted.signal, 'SIGTERM');
  assert.equal(report.stages.cleanup.status, 'passed');
  assert.equal((await readFile(value.deleted, 'utf8')).trim(), 'native-test');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('native cleanup failure prevents a successful qualification result', async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_DELETE_FAIL: '1' });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.deploymentVerified, true);
  assert.equal(report.status, 'failed');
  assert.equal(report.stages.cleanup.status, 'failed');
  assert.equal(report.stages.cleanup.exitCode, 7);
  assert.doesNotMatch(await readFile(value.calls, 'utf8'), /sandbox delete/);
});

test('native cleanup verifies the runtime is absent after a successful destroy command', async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_DESTROY_LEAVES_RUNTIME: '1' });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.deploymentVerified, true);
  assert.notEqual(report.stages.cleanup.status, 'passed');
  assert.equal(report.status, 'failed');
  assert.doesNotMatch(await readFile(value.calls, 'utf8'), /sandbox delete/);
});

test('native cleanup verifies the lifecycle state is retired after a successful destroy command', async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_DESTROY_LEAVES_NATIVE: '1' });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.deploymentVerified, true);
  assert.notEqual(report.stages.cleanup.status, 'passed');
  assert.equal(report.status, 'failed');
  assert.ok(JSON.parse(await readFile(value.registry, 'utf8')).sandboxes['native-test']);
});

test('native state preflight preserves registry and retained recovery records before claiming ownership', async (t) => {
  for (const key of ['NHA_NATIVE_TEST_RETAINED', 'NHA_NATIVE_TEST_REGISTERED']) {
    const value = await fixture(t, { [key]: 'native-test' });
    const before = await readFile(key === 'NHA_NATIVE_TEST_RETAINED' ? value.retained : value.registry, 'utf8');
    const result = runNative(value);
    assert.equal(result.status, 1, result.stderr);
    const report = await readReport(value, result);
    assert.notEqual(report.sandboxResource.ownership, 'owned');
    assert.equal(report.nativeState.ownership, 'pre-existing');
    assert.notEqual(report.stages['native-state'].status, 'passed');
    assert.equal(report.stages.cleanup.status, 'skipped');
    assert.equal(report.stages.onboard, undefined);
    assert.equal(await readFile(key === 'NHA_NATIVE_TEST_RETAINED' ? value.retained : value.registry, 'utf8'), before);
    await assert.rejects(readFile(value.onboardPid), { code: 'ENOENT' });
    await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
  }
});

test('native preflight preserves resumable onboarding history for another sandbox', async (t) => {
  const session = JSON.stringify({ version: 1, status: 'failed', sandboxName: 'other-run', resumable: true, cancellationRecovery: null });
  const value = await fixture(t, { NHA_NATIVE_TEST_PRIOR_SESSION: session });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.notEqual(report.sandboxResource.ownership, 'owned');
  assert.equal(report.stages.onboard, undefined);
  assert.equal(await readFile(value.session, 'utf8'), session);
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
});

test('native preflight fails closed when the pinned lifecycle state contract is unavailable', async (t) => {
  const value = await fixture(t);
  await rm(path.join(value.checkout, 'dist/lib/state/onboard-session.js'));
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.nativeState.ownership, 'unknown');
  assert.notEqual(report.stages['native-state'].status, 'passed');
  assert.equal(report.stages.cleanup.status, 'skipped');
  await assert.rejects(readFile(value.onboardPid), { code: 'ENOENT' });
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
});

test('native lifecycle cleanup allows a same-name retry and keeps non-default gateway binding', async (t) => {
  const value = await fixture(t, { NEMOCLAW_GATEWAY_PORT: '9090' });
  value.args[value.args.indexOf('--gateway') + 1] = 'nemoclaw-9090';
  for (let attempt = 0; attempt < 2; attempt++) {
    value.report = path.join(value.root, 'report-' + attempt + '.json');
    value.args[value.args.indexOf('--json') + 1] = value.report;
    const result = runNative(value);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = await readReport(value, result);
    assert.equal(report.stages.cleanup.status, 'passed');
    assert.equal(report.gateway.name, 'nemoclaw-9090');
  }
  const destroys = (await readFile(value.envLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(item => item.operation === 'destroy');
  assert.equal(destroys.length, 2);
  for (const child of destroys) {
    assert.equal(child.port, '9090');
    assert.equal(child.workspace, 'native-fixture');
  }
  assert.doesNotMatch(await readFile(value.calls, 'utf8'), /sandbox delete/);
});

test('native preflight preserves an existing sandbox without onboarding or deletion', async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_EXISTING: 'native-test' });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.status, 'failed');
  assert.equal(report.sandboxResource.ownership, 'pre-existing');
  assert.equal(report.stages.preflight.errorCode, 'SANDBOX_EXISTS');
  assert.equal(report.stages.cleanup.status, 'skipped');
  assert.equal(report.stages.onboard, undefined);
  await assert.rejects(readFile(value.onboardPid), { code: 'ENOENT' });
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
});

test('native unsupported checkout failure is retained in the report', async (t) => {
  const value = await fixture(t, { NHA_NATIVE_TEST_REVISION: '0'.repeat(40) });
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  const report = await readReport(value, result);
  assert.equal(report.status, 'failed');
  assert.equal(report.loaderAccepted, false);
  assert.equal(report.stages.install.status, 'failed');
  assert.match(JSON.stringify(report.stages.install), /UNSUPPORTED_UPSTREAM/);
  assert.equal(report.stages.cleanup.status, 'skipped');
  await assert.rejects(readFile(value.calls), { code: 'ENOENT' });
});

test('native refuses to overwrite an existing report before changing the checkout', async (t) => {
  const value = await fixture(t);
  const existing = '{"status":"previous-run","evidence":"preserve"}\n';
  await writeFile(value.report, existing);
  const result = runNative(value);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(await readFile(value.report, 'utf8'), existing);
  await assert.rejects(readFile(path.join(value.checkout, 'agents/native-echo/manifest.yaml')), { code: 'ENOENT' });
  await assert.rejects(readFile(value.calls), { code: 'ENOENT' });
});

/** UNOFFICIAL quickstart integration tests: real SDK commands, isolated upstream tools. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_CONTRACT } from '../src/index.mjs';
const runner = fileURLToPath(new URL('../scripts/quickstart.mjs', import.meta.url));
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
async function executable(target, source) {
  await writeFile(target, '#!' + process.execPath + '\n' + source + '\n');
  await chmod(target, 0o755);
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-quickstart-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'NemoClaw'), workdir = path.join(root, 'work');
  const tooling = path.join(root, 'tools'), fixtureHome = path.join(root, 'home');
  const openshellDir = path.join(fixtureHome, '.local/bin');
  for (const dir of ['agents', 'bin', 'scripts', 'dist/lib/agent', 'dist/lib/onboard/workload', 'dist/lib/state/registry', 'dist/lib/state/onboard-session']) await mkdir(path.join(checkout, dir), { recursive: true });
  await mkdir(tooling); await mkdir(openshellDir, { recursive: true });
  const stateDir = path.join(root, 'native-state'); await mkdir(stateDir);
  const registry = path.join(stateDir, 'registry.json'), session = path.join(stateDir, 'session.json'), retained = path.join(stateDir, 'retained.json');
  await writeFile(path.join(checkout, 'dist/lib/state/registry/persistence.js'), 'exports.REGISTRY_FILE = ' + JSON.stringify(registry) + ';\n');
  await writeFile(path.join(checkout, 'dist/lib/state/onboard-session.js'), 'exports.SESSION_FILE = ' + JSON.stringify(session) + '; exports.SESSION_DIR = require("node:path").dirname(exports.SESSION_FILE); exports.RETAINED_SANDBOX_RECOVERY_FILE = ' + JSON.stringify(retained) + ';\n');
  await writeFile(path.join(checkout, 'dist/lib/state/onboard-session/retained-sandbox-recovery.js'), "exports.retainedRebuildSessionFileName = (name) => '.onboard-rebuild-' + name + '.json';\n");
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ name: 'nemoclaw', type: 'commonjs' }));
  await writeFile(path.join(checkout, 'dist/lib/agent/defs.js'), [
    "const path = require('node:path');",
    "exports.listAgents = () => ['my-harness'];",
    "exports.loadAgent = (name) => ({ dockerfilePath: path.join(process.cwd(), 'agents', name, 'Dockerfile'), runtime: { kind: 'terminal' }, configPaths: { dir: path.join(process.cwd(), 'agents', name) } });",
  ].join('\n'));
  await writeFile(path.join(checkout, 'dist/lib/agent/onboard.js'), "exports.getAgentPolicyPath = (agent) => require('node:path').join(require('node:path').dirname(agent.dockerfilePath), 'policy-additions.yaml');\n");
  await writeFile(path.join(checkout, 'dist/lib/onboard/workload/source.js'), "exports.resolveSandboxWorkloadSource = ({ legacyDockerfilePath }) => ({ kind: 'legacy-dockerfile', dockerfilePath: legacyDockerfilePath, reason: 'fixture' });\n");
  await writeFile(path.join(checkout, 'dist/lib/onboard.js'), [
    "exports.startDockerDriverGateway = async (options) => {",
    "  const fs = require('node:fs');",
    "  fs.appendFileSync(process.env.NHA_TEST_CALL_LOG, 'bootstrap\\n');",
    "  fs.writeFileSync(process.env.NHA_TEST_BOOTSTRAP_OPTIONS, JSON.stringify(options));",
    "  if (options.skipSandboxBridgeReachability === true) throw new Error('Sandbox bridge verification must not be skipped');",
    "  if (process.env.NHA_TEST_BOOTSTRAP_FAIL) throw new Error('Fixture sandbox bridge is unreachable');",
    '};',
  ].join('\n'));
  await writeFile(path.join(checkout, 'scripts/install-openshell.sh'), '#!/bin/sh\nprintf \'%s\\n\' install >> "$NHA_TEST_CALL_LOG"\nexit 0\n');
  execFileSync(realGit, ['-C', checkout, 'init', '-q'], { stdio: 'pipe' });
  await executable(path.join(tooling, 'git'), [
    "const { spawnSync } = require('node:child_process'); const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args.slice(-3).join(' ') === 'rev-parse --verify HEAD') console.log(process.env.NHA_TEST_REVISION || " + JSON.stringify(NATIVE_CONTRACT.revision) + ');',
    "else if (args[0] === 'fetch' && process.env.NHA_TEST_FETCH_FAIL) { fs.appendFileSync(process.env.NHA_TEST_FETCH_LOG, 'fetch\\n'); process.exitCode = 7; }",
    'else { const result = spawnSync(' + JSON.stringify(realGit) + ", args, { stdio: 'inherit' }); process.exitCode = result.status ?? 1; }",
  ].join('\n'));
  await executable(path.join(tooling, 'docker'), "process.exitCode = Number(process.env.NHA_TEST_DOCKER_EXIT || '0');");
  await writeFile(path.join(checkout, 'bin/nemoclaw.js'), [
    "const fs = require('node:fs'); const path = require('node:path'); const { spawnSync } = require('node:child_process');",
    "const action = process.argv[2]; const env = process.env;",
    "if (action === '--version') { console.log('nemoclaw fixture'); process.exit(0); }",
    "fs.appendFileSync(env.NHA_TEST_CALL_LOG, action + ' ' + (process.argv[3] || '') + '\\n');",
    "if (action === 'onboard') {",
    "  fs.writeFileSync(env.NHA_TEST_PID, String(process.pid)); fs.writeFileSync(env.NHA_TEST_CREATED, process.argv[process.argv.indexOf('--name') + 1]);",
    "  fs.writeFileSync(env.NHA_TEST_REGISTRY, JSON.stringify({ sandboxes: { 'my-sandbox': { name: 'my-sandbox' } } }));",
    "  if (env.NHA_TEST_EMIT_SECRET) console.error('provider response ' + env.NEMOCLAW_PROVIDER_KEY);",
    "  if (env.NHA_TEST_REPORT_FAIL) { fs.renameSync(env.NHA_TEST_REPORT, env.NHA_TEST_REPORT + '.saved'); fs.mkdirSync(env.NHA_TEST_REPORT); }",
    "  if (env.NHA_TEST_HANG) setInterval(() => {}, 1000); else process.exitCode = Number(env.NHA_TEST_ONBOARD_EXIT || '0');",
    "} else if (process.argv[3] === 'destroy') {",
    "  if (process.argv.includes('--force') || !process.argv.includes('--no-cleanup-gateway')) process.exit(9);",
    "  if (env.NHA_TEST_REQUIRE_EXIT && fs.existsSync(env.NHA_TEST_PID)) { try { process.kill(Number(fs.readFileSync(env.NHA_TEST_PID, 'utf8')), 0); process.exit(8); } catch (error) { if (error.code !== 'ESRCH') throw error; } }",
    "  fs.appendFileSync(env.NHA_TEST_DELETE_LOG, (action === 'sandbox' ? process.argv[4] : action) + '\\n');",
    "  if (env.NHA_TEST_DELETE_FAIL) { console.error('deletion refused'); process.exit(7); }",
    "  if (env.NHA_TEST_FALSE_DELETE) { console.log('deleted'); process.exit(0); }",
    "  fs.rmSync(env.NHA_TEST_CREATED, { force: true }); fs.rmSync(env.NHA_TEST_REGISTRY, { force: true }); console.log('deleted');",
    "} else if (process.argv[3] === 'exec') {",
    "  const harness = path.join(__dirname, '../agents/my-harness/harness.mjs');",
    "  const result = spawnSync(process.execPath, [harness, process.argv.at(-1)], { stdio: 'inherit' }); process.exitCode = result.status ?? 1;",
    '} else process.exitCode = 1;',
  ].join('\n'));
  await executable(path.join(openshellDir, 'openshell'), [
    "const fs = require('node:fs'); const args = process.argv.slice(2); const env = process.env; const name = args.at(-1);",
    "if (args[0] === '--version') { console.log('openshell fixture'); process.exit(0); }",
    "fs.appendFileSync(env.NHA_TEST_CALL_LOG, args.join(' ') + '\\n');",
    "if (args[0] === 'gateway' && args[1] === 'select') process.exit(0);",
    "if (args[0] === 'status') { console.log('Status: Connected'); process.exit(0); }",
    "if (args[0] === 'logs') { console.log('fixture diagnostics'); process.exit(0); }",
    "if (args[0] === 'sandbox' && args[1] === 'get') {",
    "  if (env.NHA_TEST_TRUNCATED_PROBE) { process[env.NHA_TEST_TRUNCATED_PROBE].write('provider lookup failed\\n' + ' '.repeat(20000) + '\\nsandbox ' + name + ' not found\\n'); process.exit(1); }",
    "  if (env.NHA_TEST_EXISTING === name || (fs.existsSync(env.NHA_TEST_CREATED) && fs.readFileSync(env.NHA_TEST_CREATED, 'utf8') === name)) { console.log('Sandbox ' + name + ' is running'); process.exit(0); }",
    "  console.error('sandbox ' + name + ' not found'); process.exit(1);",
    '} process.exit(1);',
  ].join('\n'));
  const report = path.join(root, 'report.json'), deleted = path.join(root, 'deleted.log'), calls = path.join(root, 'calls.log'), pid = path.join(root, 'onboard.pid');
  return { root, checkout, workdir, report, deleted, calls, pid, registry, session, retained,
    args: [runner, '--workdir', workdir, '--nemoclaw', checkout, '--json', report],
    env: { ...process.env, HOME: fixtureHome, PATH: tooling + path.delimiter + process.env.PATH,
      NEMOCLAW_GATEWAY_PORT: '', OPENSHELL_WORKSPACE: 'quickstart-fixture',
      NEMOCLAW_ENDPOINT_URL: 'http://fixture.invalid/v1', NEMOCLAW_PROVIDER_KEY: 'fixture-key-not-real',
      NHA_TEST_CALL_LOG: calls, NHA_TEST_DELETE_LOG: deleted, NHA_TEST_PID: pid,
      NHA_TEST_CREATED: path.join(root, 'created'), NHA_TEST_REPORT: report, NHA_TEST_REGISTRY: registry, NHA_TEST_BOOTSTRAP_OPTIONS: path.join(root, 'bootstrap-options.json'), NHA_TEST_FETCH_LOG: path.join(root, 'fetch.log'), ...overrides },
  };
}
function runQuickstart(value, extra = []) {
  const result = spawnSync(process.execPath, [...value.args, ...extra], { env: value.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
async function report(value) { return JSON.parse(await readFile(value.report, 'utf8')); }
async function waitForFile(target) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { return await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for ' + target);
}

test('quickstart keeps its sandbox by default and records gateway bootstrap before ownership', async (t) => {
  const value = await fixture(t); const result = runQuickstart(value);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = await report(value);
  assert.equal(saved.status, 'passed'); assert.equal(saved.deploymentVerified, true);
  assert.deepEqual(saved.gateway, { name: 'nemoclaw', port: 8080, workspace: 'quickstart-fixture' });
  assert.equal(saved.sandbox.ownership, 'owned'); assert.equal(saved.stages.cleanup.status, 'skipped');
  const calls = await readFile(value.calls, 'utf8');
  assert.ok(calls.indexOf('bootstrap') < calls.indexOf('sandbox get'));
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
  assert.match(result.stdout, /QUICKSTART OK/);
});

test('quickstart customizes the actual installed payload and destroys only its own sandbox', async (t) => {
  const value = await fixture(t); const result = runQuickstart(value, ['--customize', '--destroy', '--gateway', 'nemoclaw-9090']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = await report(value);
  assert.equal(saved.status, 'passed'); assert.equal(saved.customizationVerified, true);
  assert.equal(saved.gateway.port, 9090); assert.equal(saved.stages.cleanup.status, 'passed');
  assert.equal(saved.stages.customizePreflight.status, 'passed');
  assert.equal(await readFile(value.deleted, 'utf8'), 'my-sandbox\nmy-sandbox\n');
  assert.match(result.stdout, /V2 Echo: NHA_NATIVE_V2/);
});

test('quickstart refuses an existing sandbox even with destroy requested', async (t) => {
  const value = await fixture(t, { NHA_TEST_EXISTING: 'my-sandbox' }); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); const saved = await report(value);
  assert.equal(saved.sandbox.ownership, 'pre-existing'); assert.equal(saved.stages.preflight.errorCode, 'SANDBOX_EXISTS');
  assert.equal(saved.stages.cleanup.status, 'skipped'); assert.equal(saved.stages.onboard, undefined);
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
});

test('quickstart persists prerequisite failures before any deployment work', async (t) => {
  const value = await fixture(t, { NHA_TEST_DOCKER_EXIT: '7' }); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); const saved = await report(value);
  assert.equal(saved.status, 'failed'); assert.equal(saved.stages.docker.status, 'failed'); assert.equal(saved.stages.checkout, undefined);
  assert.equal(saved.sandbox.ownership, 'unknown'); await assert.rejects(readFile(value.calls), { code: 'ENOENT' });
});

test('quickstart bounds onboarding and redacts credentials before console and report capture', async (t) => {
  const secret = 'fixture-provider-secret-unique-123456789';
  const value = await fixture(t, { NHA_TEST_HANG: '1', NHA_TEST_EMIT_SECRET: '1', NEMOCLAW_PROVIDER_KEY: secret });
  const result = runQuickstart(value, ['--destroy', '--timeout-ms', '2500']);
  assert.equal(result.status, 1); const saved = await report(value);
  assert.equal(saved.stages.onboard.errorCode, 'TIMEOUT'); assert.equal(saved.stages.cleanup.status, 'passed');
  assert.equal(saved.diagnostics.logs.status, 'passed');
  const output = result.stdout + result.stderr + await readFile(value.report, 'utf8');
  assert.ok(!output.includes(secret)); assert.match(output, /\[REDACTED\]/);
});

test('quickstart SIGTERM terminates onboarding before cleaning its durable owned receipt', { timeout: 30000 }, async (t) => {
  const value = await fixture(t, { NHA_TEST_HANG: '1', NHA_TEST_REQUIRE_EXIT: '1' });
  const child = spawn(process.execPath, value.args, { env: value.env, stdio: 'ignore' }); const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const pid = Number(await waitForFile(value.pid));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const receipt = await report(value); assert.equal(receipt.status, 'running'); assert.equal(receipt.sandbox.ownership, 'owned');
  child.kill('SIGTERM'); assert.equal((await exited)[0], 143);
  const saved = await report(value); assert.equal(saved.status, 'interrupted'); assert.equal(saved.stages.cleanup.status, 'passed');
  assert.equal(await readFile(value.deleted, 'utf8'), 'my-sandbox\n');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('quickstart cleanup failure prevents QUICKSTART OK', async (t) => {
  const value = await fixture(t, { NHA_TEST_DELETE_FAIL: '1' }); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); const saved = await report(value);
  assert.equal(saved.deploymentVerified, true); assert.equal(saved.status, 'failed'); assert.equal(saved.stages.cleanup.status, 'failed');
  assert.doesNotMatch(result.stdout, /QUICKSTART OK/);
});

test('quickstart still deletes its owned sandbox if report persistence fails after onboarding', async (t) => {
  const value = await fixture(t, { NHA_TEST_REPORT_FAIL: '1' }); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); assert.equal(await readFile(value.deleted, 'utf8'), 'my-sandbox\n');
  assert.equal(JSON.parse(await readFile(value.report + '.saved', 'utf8')).sandbox.ownership, 'owned');
  assert.doesNotMatch(result.stdout, /QUICKSTART OK/);
});

test('quickstart retries fetching a partial clone instead of failing on its existing origin', async (t) => {
  const value = await fixture(t, { NHA_TEST_FETCH_FAIL: '1' });
  const index = value.args.indexOf('--nemoclaw'); value.args.splice(index, 2);
  const first = runQuickstart(value); assert.equal(first.status, 1);
  assert.equal((await report(value)).stages.checkoutFetch.status, 'failed');
  await rm(value.report);
  const second = runQuickstart(value); assert.equal(second.status, 1);
  assert.equal((await report(value)).stages.checkoutFetch.status, 'failed');
  assert.equal(await readFile(value.env.NHA_TEST_FETCH_LOG, 'utf8'), 'fetch\nfetch\n');
});


test('quickstart refuses an unsupported revision before running the runtime installer', async (t) => {
  const value = await fixture(t, { NHA_TEST_REVISION: '0'.repeat(40) }); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); const saved = await report(value);
  assert.equal(saved.stages.install.status, 'failed'); assert.equal(saved.stages.openshellInstall, undefined);
  assert.equal(saved.stages.cleanup.status, 'skipped');
  await assert.rejects(readFile(value.calls), { code: 'ENOENT' });
});

test('quickstart preserves an existing report before beginning its tutorial', async (t) => {
  const value = await fixture(t); const original = '{"status":"prior-evidence"}\n';
  await writeFile(value.report, original); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); assert.equal(await readFile(value.report, 'utf8'), original);
  await assert.rejects(readFile(value.calls), { code: 'ENOENT' });
});


test('quickstart creates its default report even when the first command fails', async (t) => {
  const value = await fixture(t, { NHA_TEST_DOCKER_EXIT: '7' });
  value.args.splice(value.args.indexOf('--json'), 2);
  const result = runQuickstart(value); assert.equal(result.status, 1);
  const names = (await readdir(value.workdir)).filter((name) => /^quickstart-.*\.json$/.test(name));
  assert.equal(names.length, 1);
  const saved = JSON.parse(await readFile(path.join(value.workdir, names[0]), 'utf8'));
  assert.equal(saved.status, 'failed'); assert.equal(saved.stages.docker.status, 'failed');
});


test('quickstart refuses native recovery records before claiming a remotely absent sandbox', async (t) => {
  const value = await fixture(t);
  await writeFile(value.retained, JSON.stringify({ schemaVersion: 1, unresolved: [{ sandboxName: 'my-sandbox' }] }));
  const result = runQuickstart(value, ['--destroy']); assert.equal(result.status, 1);
  const saved = await report(value); assert.equal(saved.nativeState.ownership, 'pre-existing');
  assert.equal(saved.stages.onboard, undefined); assert.equal(saved.stages.cleanup.status, 'skipped');
  assert.deepEqual(JSON.parse(await readFile(value.retained, 'utf8')).unresolved, [{ sandboxName: 'my-sandbox' }]);
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
});


test('quickstart rejects a successful destroy exit that leaves sandbox resources behind', async (t) => {
  const value = await fixture(t, { NHA_TEST_FALSE_DELETE: '1' }); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); const saved = await report(value);
  assert.equal(saved.status, 'failed'); assert.equal(saved.stages.cleanup.status, 'failed');
  assert.equal(JSON.parse(await readFile(value.registry, 'utf8')).sandboxes['my-sandbox'].name, 'my-sandbox');
  assert.doesNotMatch(result.stdout, /QUICKSTART OK/);
});


test('quickstart never claims ownership from a truncated sandbox absence response', async (t) => {
  for (const stream of ['stdout', 'stderr']) await t.test(stream, async (t) => {
    const value = await fixture(t, { NHA_TEST_TRUNCATED_PROBE: stream }); const result = runQuickstart(value, ['--destroy']);
    assert.equal(result.status, 1); const saved = await report(value);
    assert.equal(saved.sandbox.ownership, 'unknown'); assert.equal(saved.nativeState.ownership, 'available');
    assert.equal(saved.stages.preflight.errorCode, 'OUTPUT_LIMIT'); assert.equal(saved.stages.onboard, undefined);
    assert.equal(saved.stages.cleanup.status, 'skipped'); await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
  });
});


test('quickstart checks sandbox bridge reachability and preserves a rejected bootstrap report', async (t) => {
  const value = await fixture(t, { NHA_TEST_BOOTSTRAP_FAIL: '1' }); const result = runQuickstart(value, ['--destroy']);
  assert.equal(result.status, 1); const saved = await report(value);
  assert.equal(saved.status, 'failed'); assert.equal(saved.stages.bootstrap.status, 'failed');
  assert.match(saved.stages.bootstrap.stderrTail, /sandbox bridge is unreachable/);
  assert.deepEqual(JSON.parse(await readFile(value.env.NHA_TEST_BOOTSTRAP_OPTIONS, 'utf8')), { exitOnFailure: false });
  assert.equal(saved.stages.onboard, undefined); assert.equal(saved.stages.gatewaySelect, undefined);
  assert.equal(saved.sandbox.ownership, 'unknown'); assert.equal(saved.stages.cleanup.status, 'skipped');
  await assert.rejects(readFile(value.deleted), { code: 'ENOENT' });
});

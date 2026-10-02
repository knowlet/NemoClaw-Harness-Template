/** UNOFFICIAL regression tests for runtime CI cleanup and its success gate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = await readFile(path.join(root, '.github/workflows/runtime-integration.yml'), 'utf8');
const compatibilityWorkflow = await readFile(path.join(root, '.github/workflows/upstream-compatibility.yml'), 'utf8');
const quickstartWorkflow = await readFile(path.join(root, '.github/workflows/quickstart.yml'), 'utf8');
const step = (document, name) => document.split('      - name: ' + name + '\n')[1].split('\n      - ')[0];
const nodeScript = block => block.split("          node --input-type=module <<'NODE'\n")[1].split('\n          NODE')[0]
  .split('\n').map(line => line.slice(10)).join('\n');
const cleanupStep = workflow.split('      - name: Cleanup disposable sandboxes\n')[1].split('\n      - name:')[0];
const cleanupScript = nodeScript(cleanupStep);
const compatibilityCleanupScript = nodeScript(step(compatibilityWorkflow, 'Cleanup compatibility sandboxes and fixture'));
const workflowIdentity = { GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'live', GITHUB_SHA: 'a'.repeat(40) };
const quickstartCleanupScript = nodeScript(step(quickstartWorkflow, 'Clean up the sandbox owned by the quickstart'));

async function cleanupFixture({ receipt, failSandbox, signalSandbox, secret, invalidPid, openshellResult = 'success',
  byocResult = 'success', onboardResult = 'success', quickstartResult = 'failure', quickstart = false, compatibility = false, leftoverSandbox, runtimeReceipts = true, leftoverNativeState, gatewayResult = 'skipped', failGateway = false, preflight, preexistingSandbox, unknownSandbox, gatewayState = 'Connected', preexistingReceipt = false }  = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nha-workflow-cleanup-'));
  try {
    await Promise.all(['bin', 'reports', 'scripts/lib'].map(name => mkdir(path.join(dir, name), { recursive: true })));
    await copyFile(path.join(root, 'scripts/lib/sandbox-cleanup.mjs'), path.join(dir, 'scripts/lib/sandbox-cleanup.mjs'));
    await copyFile(path.join(root, 'scripts/lib/qualification.mjs'), path.join(dir, 'scripts/lib/qualification.mjs'));
    await writeFile(path.join(dir, 'bin/openshell'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const sandbox = args.at(-1);
fs.appendFileSync(process.env.CLEANUP_TRACE, JSON.stringify({ args, workspace: process.env.OPENSHELL_WORKSPACE }) + '\\n');
if (process.env.SYNTHETIC_API_KEY) console.error('credential=' + process.env.SYNTHETIC_API_KEY);
if (args[0] === 'status') { console.log('Status: ' + process.env.GATEWAY_STATE); process.exit(0); }
if (args[0] === 'gateway' && args[1] === 'remove') process.exit(process.env.FAIL_GATEWAY === '1' ? 1 : 0);
if (args[1] === 'get' && sandbox === process.env.PREEXISTING_SANDBOX) { console.log('Sandbox exists'); process.exit(0); }
if (args[1] === 'get' && sandbox === process.env.UNKNOWN_SANDBOX) { console.error('Gateway unavailable'); process.exit(1); }
if (sandbox === process.env.FAIL_SANDBOX) {
  console.error('Permission denied deleting sandbox ' + sandbox);
  process.exitCode = 1;
} else if (args[1] === 'get' && sandbox === process.env.LEFTOVER_SANDBOX) {
  console.log('Sandbox ' + sandbox + ' is still present');
} else {
  console.error('Sandbox ' + sandbox + ' does not exist');
  process.exitCode = 1;
}
if (sandbox === process.env.SIGNAL_SANDBOX) process.kill(process.pid, 'SIGTERM');
`, { mode: 0o755 });
    await writeFile(path.join(dir, 'absent-registry.json'), JSON.stringify({ defaultSandbox: null, sandboxes: preflight ? {} : { 'nha-native': {}, 'nha-host': {} } }));
    for (const folder of ['checkout', '.upstream/NemoClaw']) {
      const checkout = path.join(dir, folder);
      await mkdir(path.join(checkout, 'bin'), { recursive: true });
      await mkdir(path.join(checkout, 'dist/lib/state/registry'), { recursive: true });
      await mkdir(path.join(checkout, 'dist/lib/state/onboard-session'), { recursive: true });
      await writeFile(path.join(checkout, 'dist/lib/state/registry/persistence.js'), 'exports.REGISTRY_FILE = ' + JSON.stringify(path.join(dir, 'absent-registry.json')) + ';');
      await writeFile(path.join(checkout, 'dist/lib/state/onboard-session.js'), 'exports.SESSION_FILE = ' + JSON.stringify(path.join(dir, 'absent-session.json')) + '; exports.SESSION_DIR = require("node:path").dirname(exports.SESSION_FILE); exports.RETAINED_SANDBOX_RECOVERY_FILE = ' + JSON.stringify(path.join(dir, 'absent-recovery.json')) + ';');
      await writeFile(path.join(checkout, 'dist/lib/state/onboard-session/retained-sandbox-recovery.js'), "exports.retainedRebuildSessionFileName = (name) => '.onboard-rebuild-' + name + '.json';\n");
      await writeFile(path.join(checkout, 'bin/nemoclaw.js'), `
const fs = require('node:fs');
const argv = process.argv.slice(2), sandbox = argv[0] === 'sandbox' ? argv[2] : argv[0];
if (argv[1] !== 'destroy' || argv.includes('--force') || !argv.includes('--no-cleanup-gateway')) process.exit(9);
const gateway = process.env.NEMOCLAW_GATEWAY_PORT === '8080' ? 'nemoclaw' : 'nemoclaw-' + process.env.NEMOCLAW_GATEWAY_PORT;
fs.appendFileSync(process.env.CLEANUP_TRACE, JSON.stringify({ args: ['sandbox', 'destroy', '-g', gateway, sandbox], workspace: process.env.OPENSHELL_WORKSPACE }) + '\\n');
if (process.env.SYNTHETIC_API_KEY) console.error('credential=' + process.env.SYNTHETIC_API_KEY);
if (sandbox === process.env.SIGNAL_SANDBOX) process.kill(process.pid, 'SIGTERM');
else if (sandbox === process.env.FAIL_SANDBOX) { console.error('Permission denied deleting sandbox ' + sandbox); process.exitCode = 1; }
else {
  const registryFile = require('node:path').resolve(process.env.NATIVE_FIXTURE_REGISTRY);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (!(sandbox === 'nha-host' && process.env.LEFTOVER_NATIVE_STATE === 'registry')) delete registry.sandboxes[sandbox];
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  console.log('Sandbox ' + sandbox + ' destroyed');
}
`);
    }
    if (leftoverNativeState === 'retained') await writeFile(path.join(dir, 'absent-recovery.json'), JSON.stringify({ schemaVersion: 1, unresolved: [{ sandboxName: 'nha-host' }] }));
    if (leftoverNativeState === 'session') await writeFile(path.join(dir, 'absent-session.json'), JSON.stringify({ version: 1, status: 'recovery_required', sandboxName: 'nha-host' }));
    if (leftoverNativeState === 'rebuild') await writeFile(path.join(dir, '.onboard-rebuild-nha-host.json'), '{"priorRecovery":true}');
    if (!quickstart && !compatibility && !preflight) {
      const values = runtimeReceipts === true ? Object.fromEntries([['nha-integration', byocResult], ['nha-host', onboardResult]].filter(([, outcome]) => ['success', 'failure', 'cancelled'].includes(outcome)).map(([sandbox]) => [sandbox, runtimeOwnedReceipt(sandbox)])) : runtimeReceipts ?? {};
      for (const [sandbox, value] of Object.entries(values)) {
        await writeFile(path.join(dir, 'reports', sandbox + '-ownership.json'), typeof value === 'string' ? value : JSON.stringify({ ...value, checkout: path.join(dir, '.upstream/NemoClaw') }));
      }
    }
    if (preflight && preexistingReceipt) await writeFile(path.join(dir, 'reports', preflight + '-ownership.json'), 'prior receipt');
    if (receipt) {
      const withCheckout = { ...receipt, checkout: path.join(dir, 'checkout') };
      await writeFile(path.join(dir, 'reports', compatibility ? 'nemoclaw-compatibility.json' : quickstart ? 'quickstart.json' : 'native.json'), JSON.stringify(compatibility ? { cases: [withCheckout] } : withCheckout));
    }
    if (invalidPid) await writeFile(path.join(dir, 'provider.pid'), '0\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', preflight ? nodeScript(step(workflow, preflight === 'nha-host' ? 'Actual NemoClaw onboarding with fixture provider' : 'Build generated adapter and test real OpenShell BYOC')) : compatibility ? compatibilityCleanupScript : quickstart ? quickstartCleanupScript : cleanupScript], {
      cwd: dir, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ...workflowIdentity, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
        GATEWAY_STATE: gatewayState, PREEXISTING_SANDBOX: preexistingSandbox ?? '', UNKNOWN_SANDBOX: unknownSandbox ?? '', LEFTOVER_NATIVE_STATE: leftoverNativeState ?? '', FAIL_GATEWAY: failGateway ? '1' : '0',
        RUNNER_TEMP: dir, OPENSHELL_RESULT: openshellResult, FAIL_SANDBOX: failSandbox ?? '', SIGNAL_SANDBOX: signalSandbox ?? '',
        BYOC_RESULT: byocResult, ONBOARD_RESULT: onboardResult, QUICKSTART_RESULT: quickstartResult,
        NATIVE_FIXTURE_REGISTRY: path.join(dir, 'absent-registry.json'), LEFTOVER_SANDBOX: leftoverSandbox ?? '', GATEWAY_RESULT: gatewayResult, SYNTHETIC_API_KEY: secret ?? '', CLEANUP_TRACE: path.join(dir, 'trace.jsonl') },
    });
    const reportText = await readFile(path.join(dir, 'reports', preflight ? preflight + '-ownership.json' : compatibility ? 'compatibility-cleanup.json' : quickstart ? 'quickstart-cleanup.json' : 'cleanup.json'), 'utf8');
    const report = preexistingReceipt ? null : JSON.parse(reportText);
    const trace = await readFile(path.join(dir, 'trace.jsonl'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return { ...result, report, reportText, allCalls: trace.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), calls: trace.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.args[1] !== 'get') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ownedReceipt = {
  sandboxResource: { ownership: 'owned', name: 'nha-native' },
  gateway: { name: 'nemoclaw-9090', port: 9090, workspace: 'bound-workspace' },
  nativeState: { schemaVersion: 'nemoclaw-native-state/v1', sandbox: 'nha-native', ownership: 'owned', home: process.env.HOME || os.homedir(), gateway: 'nemoclaw-9090', gatewayPort: 9090, workspace: 'bound-workspace' },
  stages: { cleanup: { status: 'failed' } },
};

function runtimeOwnedReceipt(sandbox) {
  const gateway = { name: 'nemoclaw', port: 8080, workspace: 'default' };
  return { schemaVersion: 'nha-runtime-ownership/v1', runIdentity: workflowIdentity, home: process.env.HOME,
    sandbox: { name: sandbox, ownership: 'owned' }, gateway, deployment: { status: 'started' },
    stages: { gateway: { status: 'passed' }, preflight: { status: 'passed' } },
    ...(sandbox === 'nha-host' ? { nativeState: { ...ownedReceipt.nativeState, sandbox, gateway: gateway.name, gatewayPort: gateway.port, workspace: gateway.workspace } } : {}),
  };
}

test('runtime cleanup records failure and continues remaining cleanup on the receipt gateway', async () => {
  const result = await cleanupFixture({ receipt: ownedReceipt, failSandbox: 'nha-integration' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.ok, false);
  assert.deepEqual(result.calls.map(call => call.args.at(-1)), ['nha-integration', 'nha-host', 'nha-native']);
  assert.deepEqual(result.calls.at(-1), {
    args: ['sandbox', 'destroy', '-g', 'nemoclaw-9090', 'nha-native'], workspace: 'bound-workspace',
  });
  assert.match(result.report.results[0].stderrTail, /Permission denied/);
  assert.equal(result.report.results[1].status, 'passed');
});

test('runtime cleanup accepts confirmed absence without deleting native sandboxes lacking ownership', async () => {
  for (const receipt of [undefined, { ...ownedReceipt, sandboxResource: { ownership: 'unknown', name: 'nha-native' } },
    { ...ownedReceipt, stages: { cleanup: { status: 'passed' } } }]) {
    const result = await cleanupFixture({ receipt });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.ok, true);
    assert.deepEqual(result.calls.map(call => call.args.at(-1)), ['nha-integration', 'nha-host']);
    assert.ok(result.report.results.filter(item => item.status === 'passed').every(item => item.absent));
  }
});

test('invalid native receipt and fixture PID fail cleanup while preserving evidence', async () => {
  const result = await cleanupFixture({ receipt: { ...ownedReceipt, gateway: {} }, invalidPid: true });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.calls.map(call => call.args.at(-1)), ['nha-integration', 'nha-host']);
  assert.equal(result.report.results.find(item => item.resource === 'native sandbox').status, 'failed');
  assert.equal(result.report.results.find(item => item.resource === 'fixture provider').status, 'failed');
});

test('failed OpenShell setup does not attempt legacy sandbox cleanup', async () => {
  const result = await cleanupFixture({ openshellResult: 'failure', byocResult: 'skipped', onboardResult: 'skipped' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test('runtime cleanup skips deployments whose prerequisites prevented them from running', async () => {
  const result = await cleanupFixture({ byocResult: 'skipped', onboardResult: 'skipped' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test('runtime cleanup redacts credentials from console and persisted evidence', async () => {
  const secret = 'synthetic-runtime-cleanup-secret-81734';
  const result = await cleanupFixture({ failSandbox: 'nha-integration', secret });
  assert.equal(result.status, 1, result.stderr);
  for (const evidence of [result.stdout, result.stderr, result.reportText]) assert.equal(evidence.includes(secret), false);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.match(result.reportText, /\[REDACTED\]/);
  assert.equal(result.report.results[0].stderr, undefined);
  assert.match(result.report.results[0].stderrTail, /Permission denied/);
});

test('runtime cleanup does not accept absence printed by a signalled command', async () => {
  const result = await cleanupFixture({ signalSandbox: 'nha-integration' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.results[0].status, 'failed');
  assert.equal(result.report.results[0].signal, 'SIGTERM');
  assert.notEqual(result.report.results[0].absent, true);
  assert.equal(result.report.results[1].status, 'passed');
});

test('runtime CI reports and uploads cleanup evidence before enforcing all outcomes', () => {
  assert.match(cleanupStep, /id: cleanup\n        if: always\(\)\n        continue-on-error: true/);
  const cleanupIndex = workflow.indexOf('- name: Cleanup disposable sandboxes');
  const reportIndex = workflow.indexOf('- name: Record outcomes');
  const artifactIndex = workflow.indexOf('- uses: actions/upload-artifact');
  const gateIndex = workflow.indexOf('- name: Require all deployment checks and cleanup to pass');
  assert.ok(cleanupIndex < reportIndex && reportIndex < artifactIndex && artifactIndex < gateIndex);
  const reportStep = workflow.slice(reportIndex, artifactIndex);
  assert.match(reportStep, /CLEANUP_RESULT: \$\{\{ steps\.cleanup\.outcome \}\}/);
  assert.match(reportStep, /"EMBEDDED", "CLEANUP"/);
  const gate = workflow.slice(gateIndex).split('        run: ')[1].trim();
  const outcomes = Object.fromEntries(['CLI', 'OPENSHELL', 'GATEWAY', 'FIXTURE', 'NATIVE_LOADER', 'ONBOARD', 'NATIVE', 'BYOC', 'EMBEDDED', 'CLEANUP']
    .map(name => [name + '_RESULT', 'success']));
  assert.equal(spawnSync('bash', ['-c', gate], { env: { ...process.env, ...outcomes } }).status, 0);
  assert.equal(spawnSync('bash', ['-c', gate], { env: { ...process.env, ...outcomes, CLEANUP_RESULT: 'failure' } }).status, 1);
  assert.equal(spawnSync('bash', ['-c', gate], { env: { ...process.env, ...outcomes, GATEWAY_RESULT: 'failure' } }).status, 1);
});

test('runtime deployment gates require the complete runtime, gateway, and fixture prerequisites', () => {
  const install = step(workflow, 'Install the pinned OpenShell CLI, gateway, and sandbox runtime');
  assert.match(install, /bash \.upstream\/NemoClaw\/scripts\/install-openshell\.sh/);
  assert.match(install, /test -x "\$openshell_dir\/openshell-gateway"/);
  assert.match(install, /test -x "\$openshell_dir\/openshell-sandbox"/);
  const eligible = (name, outcomes) => {
    const expression = step(workflow, name).match(/        if: \$\{\{ (.+) \}\}/)[1]
      .replaceAll('cancelled()', 'false')
      .replace(/steps\.([\w-]+)\.outcome/g, (_match, key) => JSON.stringify(outcomes[key] ?? 'skipped'));
    return new Function('return ' + expression)();
  };
  const native = 'Onboard and execute the generated native agent in a real sandbox';
  const good = { 'native-loader': 'success', gateway: 'success', fixture: 'success' };
  assert.equal(eligible(native, good), true);
  for (const key of ['native-loader', 'gateway', 'fixture']) assert.equal(eligible(native, { ...good, [key]: 'failure' }), false);
  assert.equal(eligible('Run harness suite inside the actual NemoClaw-managed sandbox', { onboard: 'failure', byoc: 'success' }), false);
  assert.equal(eligible('Run harness suite inside the actual NemoClaw-managed sandbox', { onboard: 'success', byoc: 'failure' }), false);
  const summary = step(workflow, 'Record outcomes without hiding deployment failures');
  for (const key of ['GATEWAY', 'FIXTURE']) assert.match(summary, new RegExp(key + '_RESULT:'));
});

test('runtime gateway bootstrap requires a connected status and persists failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nha-workflow-gateway-'));
  try {
    await Promise.all(['bin', 'reports', 'scripts/lib', '.upstream/NemoClaw/dist/lib'].map(name => mkdir(path.join(dir, name), { recursive: true })));
    for (const file of ['sandbox-cleanup.mjs', 'qualification.mjs']) {
      await copyFile(path.join(root, 'scripts/lib', file), path.join(dir, 'scripts/lib', file));
    }
    await writeFile(path.join(dir, '.upstream/NemoClaw/dist/lib/onboard.js'), 'exports.startDockerDriverGateway = async () => {};\n');
    await writeFile(path.join(dir, 'bin/openshell'), '#!/bin/sh\nif [ "$1" = status ]; then echo "Status: $GATEWAY_STATE"; fi\n', { mode: 0o755 });
    const script = nodeScript(step(workflow, 'Bootstrap and verify the managed gateway'));
    for (const state of ['Connected', 'Disconnected', 'Not Connected']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: dir, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, GATEWAY_STATE: state },
      });
      const report = JSON.parse(await readFile(path.join(dir, 'reports/gateway.json'), 'utf8'));
      assert.equal(report.stages.bootstrap.status, 'passed');
      assert.equal(result.status, state === 'Connected' ? 0 : 1, result.stderr);
      assert.equal(report.stages.status.status, state === 'Connected' ? 'passed' : 'failed');
      if (state !== 'Connected') assert.equal(report.stages.status.errorCode, 'GATEWAY_UNHEALTHY');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a live fixture without its ready marker cannot pass on a foreign listener', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nha-workflow-fixture-'));
  let childPid;
  try {
    await mkdir(path.join(dir, 'bin'));
    await writeFile(path.join(dir, 'bin/node'), `#!${process.execPath}\nconsole.log('fixture child alive ' + process.pid); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    await writeFile(path.join(dir, 'bin/curl'), '#!/bin/sh\necho foreign-listener-contacted >> "$RUNNER_TEMP/curl.trace"\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(dir, 'bin/sleep'), '#!/bin/sh\nexec /bin/sleep 0.01\n', { mode: 0o755 });
    for (const [document, name, prefix] of [[workflow, 'Start and verify the deterministic provider fixture', 'provider'], [compatibilityWorkflow, 'Start deterministic provider fixture', 'compat-provider']]) {
      const script = step(document, name).split('        run: |\n')[1]
        .split('\n').map(line => line.slice(10)).join('\n');
      const result = spawnSync('bash', ['-e', '-c', script], {
        cwd: dir, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, RUNNER_TEMP: dir },
      });
      childPid = Number((await readFile(path.join(dir, prefix + '.pid'), 'utf8')).trim());
      assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
      assert.equal(result.status, 1, result.stderr);
      assert.equal((await readFile(path.join(dir, prefix + '.log'), 'utf8')).trim(), 'fixture child alive ' + childPid);
      assert.equal(await readFile(path.join(dir, 'curl.trace'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }), '');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try { process.kill(childPid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
      childPid = undefined;
    }
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(dir, { recursive: true, force: true });
  }
});

test('quickstart fallback cleanup uses only the owned receipt and bound gateway', async () => {
  const receipt = { sandbox: ownedReceipt.sandboxResource, gateway: ownedReceipt.gateway, stages: ownedReceipt.stages, nativeState: ownedReceipt.nativeState };
  const cleaned = await cleanupFixture({ quickstart: true, receipt });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.deepEqual(cleaned.calls, [{ args: ['sandbox', 'destroy', '-g', 'nemoclaw-9090', 'nha-native'], workspace: 'bound-workspace' }]);
  for (const sandbox of [{ name: 'my-sandbox', ownership: 'pre-existing' }, { name: 'my-harness', ownership: 'unknown' }]) {
    const skipped = await cleanupFixture({ quickstart: true, receipt: { ...receipt, sandbox } });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.deepEqual(skipped.calls, []);
  }
});

test('quickstart cleanup failure preserves redacted evidence and cannot pass the final gate', async () => {
  const receipt = { sandbox: ownedReceipt.sandboxResource, gateway: ownedReceipt.gateway, stages: ownedReceipt.stages, nativeState: ownedReceipt.nativeState };
  const secret = 'synthetic-quickstart-cleanup-secret-42781';
  const result = await cleanupFixture({ quickstart: true, receipt, failSandbox: 'nha-native', secret });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.status, 'failed');
  for (const evidence of [result.stdout, result.stderr, result.reportText]) assert.equal(evidence.includes(secret), false);
  const missing = await cleanupFixture({ quickstart: true, quickstartResult: 'success' });
  assert.equal(missing.status, 1, missing.stderr);
  const gate = step(quickstartWorkflow, 'Require the quickstart and cleanup to pass').split('        run: ')[1].trim();
  assert.equal(spawnSync('bash', ['-c', gate], { env: { ...process.env, QUICKSTART_RESULT: 'success', CLEANUP_RESULT: 'failure' } }).status, 1);
  assert.ok(quickstartWorkflow.indexOf('- name: Clean up the sandbox owned by the quickstart') < quickstartWorkflow.indexOf('- uses: actions/upload-artifact'));
  assert.match(quickstartWorkflow, /--json reports\/quickstart\.json/);
  assert.match(quickstartWorkflow, /            reports\/quickstart-cleanup\.json/);
});


test('native workflow cleanup retries an interrupted receipt without raw deletion', async () => {
  for (const quickstart of [false, true]) {
    const receipt = { ...ownedReceipt, ...(quickstart ? { sandbox: ownedReceipt.sandboxResource } : {}), stages: { cleanup: { status: 'running' } } };
    const result = await cleanupFixture({ receipt, quickstart, byocResult: 'skipped', onboardResult: 'skipped' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(result.calls.map(call => call.args[1]), ['destroy']);
  }
});

test('native workflow cleanup rejects destroy success when the sandbox is still present', async () => {
  for (const quickstart of [false, true]) {
    const receipt = { ...ownedReceipt, ...(quickstart ? { sandbox: ownedReceipt.sandboxResource } : {}) };
    const result = await cleanupFixture({ receipt, quickstart, byocResult: 'skipped', onboardResult: 'skipped', leftoverSandbox: 'nha-native' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.reportText, /SANDBOX_ABSENCE_UNVERIFIED/);
    assert.deepEqual(result.calls.map(call => call.args[1]), ['destroy']);
  }
});

test('compatibility fallback uses native ownership and its cleanup is a required gate', async () => {
  const receipt = { ...ownedReceipt, sandbox: ownedReceipt.sandboxResource, stages: { cleanup: { status: 'running' } } };
  const success = await cleanupFixture({ compatibility: true, receipt });
  assert.equal(success.status, 0, success.stderr + success.stdout);
  assert.deepEqual(success.calls, [{ args: ['sandbox', 'destroy', '-g', 'nemoclaw-9090', 'nha-native'], workspace: 'bound-workspace' }]);
  const refused = await cleanupFixture({ compatibility: true, receipt, failSandbox: 'nha-native' });
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(refused.calls.map(call => call.args[1]), ['destroy']);
  const unverified = await cleanupFixture({ compatibility: true, receipt: { ...receipt, nativeState: undefined } });
  assert.equal(unverified.status, 1, unverified.stderr);
  assert.deepEqual(unverified.calls, []);
  const gate = step(compatibilityWorkflow, 'Require compatibility qualification to pass').split('        run: ')[1].trim();
  const env = { ...process.env, OPENSHELL_RESULT: 'success', GATEWAY_RESULT: 'success', FIXTURE_RESULT: 'success', COMPATIBILITY_RESULT: 'success', CLEANUP_RESULT: 'failure' };
  assert.equal(spawnSync('bash', ['-c', gate], { env }).status, 1);
  assert.equal(spawnSync('bash', ['-c', gate], { env: { ...env, CLEANUP_RESULT: 'success' } }).status, 0);
  assert.match(compatibilityWorkflow, /            reports\/compatibility-cleanup\.json/);
});


test('fixed runtime ownership is durable before deployment and refuses reused receipts', async () => {
  for (const sandbox of ['nha-host', 'nha-integration']) {
    const result = await cleanupFixture({ preflight: sandbox });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.sandbox.ownership, 'owned');
    assert.equal(result.report.deployment.status, 'started');
    assert.deepEqual(result.report.runIdentity, workflowIdentity);
    assert.deepEqual(result.report.gateway, { name: 'nemoclaw', port: 8080, workspace: 'default' });
    assert.equal(result.report.stages.preflight.status, 'passed');
    if (sandbox === 'nha-host') assert.equal(result.report.nativeState.ownership, 'owned');
    const reused = await cleanupFixture({ preflight: sandbox, preexistingReceipt: true });
    assert.notEqual(reused.status, 0);
    assert.equal(reused.reportText, 'prior receipt');
    assert.deepEqual(reused.allCalls, []);
    const block = step(workflow, sandbox === 'nha-host' ? 'Actual NemoClaw onboarding with fixture provider' : 'Build generated adapter and test real OpenShell BYOC');
    assert.ok(block.indexOf('receipt.deployment.status =') < block.indexOf(sandbox === 'nha-host' ? 'timeout 900' : 'timeout 180'));
    if (sandbox === 'nha-integration') assert.ok(block.indexOf('docker build') < block.indexOf("node --input-type=module"));
  }
});

test('fixed runtime preflight never claims existing, unknown, or retained native resources', async () => {
  for (const sandbox of ['nha-host', 'nha-integration']) {
    for (const option of [{ preexistingSandbox: sandbox }, { unknownSandbox: sandbox }, { gatewayState: 'Not Connected' }]) {
      const result = await cleanupFixture({ preflight: sandbox, ...option });
      assert.notEqual(result.status, 0, result.stderr);
      assert.notEqual(result.report.sandbox.ownership, 'owned');
      assert.equal(result.report.deployment.status, 'pending');
    }
  }
  for (const leftoverNativeState of ['retained', 'session', 'rebuild']) {
    const result = await cleanupFixture({ preflight: 'nha-host', leftoverNativeState });
    assert.notEqual(result.status, 0, result.stderr);
    assert.notEqual(result.report.sandbox.ownership, 'owned');
    assert.equal(result.report.deployment.status, 'pending');
    assert.equal(result.allCalls.some(call => call.args[1] === 'get'), false);
  }
});

test('fixed runtime cleanup requires current scoped ownership rather than deployment outcomes', async () => {
  for (const sandbox of ['nha-host', 'nha-integration']) {
    for (const ownership of ['unknown', 'pre-existing']) {
      const receipt = { ...runtimeOwnedReceipt(sandbox), sandbox: { name: sandbox, ownership } };
      const result = await cleanupFixture({ runtimeReceipts: { [sandbox]: receipt }, byocResult: sandbox === 'nha-integration' ? 'failure' : 'skipped', onboardResult: sandbox === 'nha-host' ? 'failure' : 'skipped' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.calls, []);
    }
    for (const receipt of ['{invalid', { ...runtimeOwnedReceipt(sandbox), runIdentity: { ...workflowIdentity, GITHUB_RUN_ATTEMPT: '1' } }, { ...runtimeOwnedReceipt(sandbox), deployment: { status: 'pending' } }, { ...runtimeOwnedReceipt(sandbox), gateway: { name: 'nemoclaw', port: 8080, workspace: 'other' } }]) {
      const result = await cleanupFixture({ runtimeReceipts: { [sandbox]: receipt }, byocResult: 'skipped', onboardResult: 'skipped' });
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.calls, []);
    }
  }
  const missing = await cleanupFixture({ runtimeReceipts: null });
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.calls, []);
  const interrupted = await cleanupFixture({ byocResult: 'cancelled', onboardResult: 'cancelled' });
  assert.equal(interrupted.status, 0, interrupted.stderr);
  assert.deepEqual(interrupted.calls.map(call => call.args.at(-1)), ['nha-integration', 'nha-host']);
});

test('host native cleanup rejects successful destroy while any lifecycle evidence remains', async () => {
  for (const leftoverNativeState of ['registry', 'retained', 'session', 'rebuild']) {
    const result = await cleanupFixture({ leftoverNativeState, byocResult: 'skipped' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.reportText, /NATIVE_STATE_REMAINS/);
    assert.deepEqual(result.calls.map(call => call.args[1]), ['destroy']);
  }
});

test('compatibility cleanup removes a gateway after a failed bootstrap attempt only when setup ran', async () => {
  for (const gatewayResult of ['success', 'failure', 'cancelled']) {
    const result = await cleanupFixture({ compatibility: true, gatewayResult });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(call => call.args.slice(0, 2)), [['gateway', 'remove']]);
  }
  for (const options of [{ gatewayResult: 'skipped' }, { gatewayResult: 'failure', openshellResult: 'skipped' }, { gatewayResult: 'failure', openshellResult: 'failure' }]) {
    const result = await cleanupFixture({ compatibility: true, ...options });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  }
  const failure = await cleanupFixture({ compatibility: true, gatewayResult: 'failure', failGateway: true });
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.reportText, /failed/);
});

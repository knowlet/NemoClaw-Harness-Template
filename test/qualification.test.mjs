/** Regression checks for the internal qualification execution/evidence helpers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupSandbox,
  collectSandboxDiagnostics,
  probeNativeState,
  resolveGatewayBinding,
  run,
  serializeReport,
  tail,
  terminateActiveCommands,
  writeReportAtomically,
} from '../scripts/lib/qualification.mjs';

test('failure diagnostics never inspect an unowned sandbox', async () => {
  let calls = 0;
  const result = { sandbox: { name: 'existing', ownership: 'pre-existing' } };
  await collectSandboxDiagnostics(result, { deploy: true, gateway: 'nemoclaw' }, async () => { calls += 1; });
  assert.equal(calls, 0);
  assert.equal(result.diagnostics, undefined);
});

test('failure diagnostics remain bounded and bound to the receipt even when one probe fails', async () => {
  const result = { status: 'failed', sandbox: { name: 'owned', ownership: 'owned' }, gateway: { name: 'nemoclaw-9090', workspace: 'ci' } };
  const calls = [];
  const diagnostics = await collectSandboxDiagnostics(result, { deploy: true, gateway: 'nemoclaw', timeoutMs: 500 }, async (argv, options) => {
    calls.push({ argv, options });
    if (calls.length === 1) throw new Error('status probe failed');
    return { code: 0, stdout: 'ContainerExited: configuration failure', stderr: '', durationMs: 1 };
  });
  assert.equal(calls.length, 2);
  for (const { argv, options } of calls) {
    assert.equal(argv[argv.indexOf('-g') + 1], 'nemoclaw-9090');
    assert.equal(options.env.OPENSHELL_WORKSPACE, 'ci');
    assert.equal(options.timeoutMs, 500);
  }
  assert.equal(diagnostics.sandbox.status, 'failed');
  assert.match(diagnostics.logs.stdoutTail, /ContainerExited/);
  assert.equal(result.status, 'failed');
});

test('command capture redacts credentials split across chunks on both streams', async () => {
  const secret = 'synthetic-provider-credential-12345';
  const script = [
    'const value = process.env.NHA_TEST_API_KEY;',
    'process.stdout.write(value.slice(0, 13));',
    'process.stderr.write(value.slice(0, 19));',
    'setTimeout(() => {',
    "  process.stdout.write(value.slice(13) + '\\nready');",
    "  process.stderr.write(value.slice(19) + '\\nfailed');",
    '}, 30);',
  ].join('\n');
  const result = await run([process.execPath, '-e', script], {
    env: { ...process.env, NHA_TEST_API_KEY: secret },
    timeoutMs: 2000,
    marker: secret,
  });
  assert.equal(result.code, 0);
  assert.equal(result.markerSeen, true);
  assert.equal(result.stdout, '[REDACTED]\nready');
  assert.equal(result.stderr, '[REDACTED]\nfailed');
});

test('rolling output cannot retain a credential suffix at its truncation boundary', async () => {
  const secret = 'synthetic-boundary-secret-' + 's'.repeat(9000);
  const script = "process.stdout.write(process.env.NHA_TEST_TOKEN); process.stdout.write('x'.repeat(10000) + '\\nLATE_DIAGNOSTIC');";
  const result = await run([process.execPath, '-e', script], {
    env: { ...process.env, NHA_TEST_TOKEN: secret },
    timeoutMs: 2000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 8192);
  assert.match(result.stdout, /^x+\nLATE_DIAGNOSTIC$/);

  const boundary = await run([process.execPath, '-e', "process.stdout.write(process.env.NHA_TEST_TOKEN + 'tail');"], {
    env: { ...process.env, NHA_TEST_TOKEN: secret },
    timeoutMs: 2000,
  });
  assert.equal(boundary.stdout, '[REDACTED]tail');
});

test('overlapping credential values are redacted without leaking either suffix', async () => {
  const result = await run([process.execPath, '-e', "process.stdout.write('abcdefgh');"], {
    env: { ...process.env, NHA_TEST_TOKEN: 'abcde', NHA_TEST_SECRET: 'defgh' },
    timeoutMs: 2000,
  });
  assert.equal(result.stdout, '[REDACTED]');
});

test('UTF-8 output remains intact within the byte limit', async () => {
  const result = await run([process.execPath, '-e', "process.stdout.write('界'.repeat(4000));"], {
    env: { ...process.env, NHA_TEST_TOKEN: 'abcdefg' },
    timeoutMs: 2000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 8192);
  assert.match(result.stdout, /^界+$/);
  const diagnostic = tail('界'.repeat(4000));
  assert.ok(Buffer.byteLength(diagnostic) <= 4096);
  assert.match(diagnostic, /^界+$/);
});

test('spawn failure returns structured diagnostics', async () => {
  const result = await run(['/nha-test-missing-command'], { timeoutMs: 2000 });
  assert.equal(result.code, null);
  assert.equal(result.errorCode, 'ENOENT');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('cancellation settles even when a detached descendant retains output pipes', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-cancel-'));
  const pidFile = path.join(root, 'descendant.pid');
  let descendantPid;
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    'writeFileSync(' + JSON.stringify(pidFile) + ', String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const pending = run([process.execPath, '-e', script], { timeoutMs: 10000 });
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { descendantPid = Number(await readFile(pidFile, 'utf8')); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(descendantPid, 'descendant started');
    const started = Date.now();
    assert.equal(terminateActiveCommands(), 1);
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, 'SIGKILL');
    assert.ok(Date.now() - started < 3000);
  } finally {
    terminateActiveCommands();
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation still escalates immediately during the timeout TERM grace', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-escalate-'));
  const marker = path.join(root, 'continued-after-cancellation');
  let terminated;
  const watcher = watch(root, (_event, filename) => {
    if (filename !== 'term-received' || terminated !== undefined) return;
    terminated = terminateActiveCommands();
    watcher.close();
  });
  const script = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {",
    // Tell the test exactly when the timeout grace begins. A cancellation must
    // kill this process before it can perform its next delayed side effect.
    '  writeFileSync(' + JSON.stringify(path.join(root, 'term-received')) + ", 'ready');",
    '  setTimeout(() => writeFileSync(' + JSON.stringify(marker) + ", 'continued'), 100);",
    '});',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  try {
    const result = await run([process.execPath, '-e', script], { timeoutMs: 300 });
    assert.equal(terminated, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, true);
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic evidence writes snapshot immediately, redact strings, and preserve valid JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-report-'));
  const target = path.join(root, 'report.json');
  const previous = process.env.NHA_TEST_REPORT_TOKEN;
  process.env.NHA_TEST_REPORT_TOKEN = 'synthetic-"report"-credential';
  try {
    const report = { status: 'running', diagnostic: process.env.NHA_TEST_REPORT_TOKEN, message: 'token=value', nested: ['preserved'] };
    const pending = writeReportAtomically(target, report);
    report.status = 'passed';
    await pending;
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {
      status: 'running', diagnostic: '[REDACTED]', message: 'token=[REDACTED]', nested: ['preserved'],
    });
    assert.equal(JSON.parse(serializeReport(report)).diagnostic, '[REDACTED]');
    await Promise.all([
      writeReportAtomically(target, { status: 'running' }),
      writeReportAtomically(target, { status: 'passed' }),
    ]);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).status, 'passed');
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ['report.json']);
  } finally {
    if (previous === undefined) delete process.env.NHA_TEST_REPORT_TOKEN;
    else process.env.NHA_TEST_REPORT_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('failed atomic rename removes its temporary file and does not poison later writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-report-'));
  try {
    await assert.rejects(writeReportAtomically(root, { status: 'running' }));
    const siblings = await readdir(path.dirname(root));
    assert.equal(siblings.some((name) => name.startsWith(path.basename(root) + '.tmp-')), false);
    const target = path.join(root, 'report.json');
    await writeReportAtomically(target, { status: 'passed' });
    assert.equal(JSON.parse(await readFile(target, 'utf8')).status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('derived gateway ports must also be valid TCP ports', () => {
  for (const gateway of ['nemoclaw-0', 'nemoclaw-65536', 'nemoclaw-999999999999999999999']) {
    assert.equal(resolveGatewayBinding({ gateway }, {}).errorCode, 'GATEWAY_PORT_INVALID');
  }
});

test('unfinished cleanup cannot turn partial absence output into success', async () => {
  for (const unfinished of [{ timedOut: true }, { signal: 'SIGTERM' }, { errorCode: 'SPAWN_FAILED' }, { cancelled: true }, { stdoutTruncated: true }, { stderrTruncated: true }]) {
    const resource = { status: 'passed', sandbox: { name: 'nha-owned', ownership: 'owned' }, stages: {} };
    await cleanupSandbox(resource, { deploy: true }, async () => ({
      code: null, stdout: 'sandbox nha-owned is already absent', stderr: '', durationMs: 1, ...unfinished,
    }));
    assert.notEqual(resource.stages.cleanup.status, 'passed');
    assert.notEqual(resource.status, 'passed');
  }
});

async function nativeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-native-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = path.join(root, 'registry.json');
  const session = path.join(root, 'session.json');
  const retained = path.join(root, 'retained.json');
  const rebuild = path.join(root, '.onboard-rebuild-fixture.json');
  await mkdir(path.join(root, 'dist/lib/state/registry'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/state/onboard-session'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}\n');
  await writeFile(path.join(root, 'dist/lib/state/registry/persistence.js'), 'exports.REGISTRY_FILE = ' + JSON.stringify(registry) + ';\n');
  await writeFile(path.join(root, 'dist/lib/state/onboard-session.js'), 'exports.SESSION_DIR = ' + JSON.stringify(root) + '; exports.SESSION_FILE = ' + JSON.stringify(session) + '; exports.RETAINED_SANDBOX_RECOVERY_FILE = ' + JSON.stringify(retained) + ';\n');
  await writeFile(path.join(root, 'dist/lib/state/onboard-session/retained-sandbox-recovery.js'), "exports.retainedRebuildSessionFileName = (name) => '.onboard-rebuild-' + name + '.json';\n");
  const flags = { deploy: true, gateway: 'nemoclaw-9090', gatewayPort: 9090, timeoutMs: 5000 };
  const env = { ...process.env, HOME: root, NEMOCLAW_GATEWAY_PORT: '9090', OPENSHELL_WORKSPACE: 'test' };
  const resource = { status: 'passed', checkout: root, gateway: { name: 'nemoclaw-9090', port: 9090, workspace: 'test' }, sandbox: { name: 'fixture', ownership: 'owned' }, stages: {} };
  resource.nativeState = { ...await probeNativeState(resource, flags, { env }), ownership: 'owned' };
  assert.equal(resource.nativeState.status, 'passed');
  return { root, registry, session, retained, rebuild, flags, env, resource };
}

test('native preflight preserves target rebuild recovery and leaves unrelated files alone', async (t) => {
  const { root, rebuild, resource, flags, env } = await nativeFixture(t);
  const unrelated = path.join(root, '.onboard-rebuild-other.json');
  const contents = '{"version":1,"sandboxName":"fixture","credential":"private-rebuild-value"}\n';
  await writeFile(unrelated, contents);
  const absent = await probeNativeState(resource, flags, { env });
  assert.equal(absent.status, 'passed');
  assert.equal(absent.rebuild, false);
  await writeFile(rebuild, contents);
  const occupied = await probeNativeState(resource, flags, { env });
  assert.equal(occupied.status, 'failed');
  assert.equal(occupied.ownership, 'pre-existing');
  assert.equal(occupied.rebuild, true);
  assert.equal(JSON.stringify(occupied).includes('private-rebuild-value'), false);
  assert.equal(await readFile(rebuild, 'utf8'), contents);
  assert.equal(await readFile(unrelated, 'utf8'), contents);
});

test('native preflight fails closed on malformed, unreadable, or symlinked rebuild files', async (t) => {
  const { root, rebuild, resource, flags, env } = await nativeFixture(t);
  await writeFile(rebuild, '{not-json');
  assert.equal((await probeNativeState(resource, flags, { env })).ownership, 'pre-existing');
  await chmod(rebuild, 0);
  assert.equal((await probeNativeState(resource, flags, { env })).ownership, 'pre-existing');
  await chmod(rebuild, 0o600);
  assert.equal(await readFile(rebuild, 'utf8'), '{not-json');
  await rm(rebuild);
  await symlink(path.join(root, 'missing-recovery'), rebuild);
  const linked = await probeNativeState(resource, flags, { env });
  assert.equal(linked.status, 'blocked');
  assert.equal(linked.errorCode, 'NATIVE_STATE_INVALID');
});

test('native preflight rejects unavailable rebuild path contracts', async (t) => {
  const { root, resource, flags, env } = await nativeFixture(t);
  const modulePath = path.join(root, 'dist/lib/state/onboard-session/retained-sandbox-recovery.js');
  for (const source of ['exports.retainedRebuildSessionFileName = null;', "exports.retainedRebuildSessionFileName = () => '../outside.json';"]) {
    await writeFile(modulePath, source);
    assert.equal((await probeNativeState(resource, flags, { env })).errorCode, 'NATIVE_STATE_UNSUPPORTED');
  }
  await writeFile(modulePath, "exports.retainedRebuildSessionFileName = (name) => '.onboard-rebuild-' + name + '.json';\n");
  await writeFile(path.join(root, 'dist/lib/state/onboard-session.js'), 'exports.SESSION_FILE = ' + JSON.stringify(path.join(root, 'session.json')) + ';\n');
  assert.equal((await probeNativeState(resource, flags, { env })).errorCode, 'NATIVE_STATE_UNSUPPORTED');
});

test('native preflight sees hidden pending and retained state without exposing file contents', async (t) => {
  const fixture = await nativeFixture(t);
  const { registry, retained, resource, flags, env } = fixture;
  const privateValue = 'synthetic-private-provider-credential';
  await writeFile(registry, JSON.stringify({ sandboxes: { fixture: { name: 'fixture', pendingRouteReservation: true, credential: privateValue } } }));
  const pending = await probeNativeState(resource, flags, { env });
  assert.equal(pending.ownership, 'pre-existing');
  assert.equal(pending.registered, true);
  assert.equal(JSON.stringify(pending).includes(privateValue), false);
  await rm(registry);
  const retainedContents = JSON.stringify({ schemaVersion: 1, unresolved: [{ sandboxName: 'fixture', credential: privateValue }] });
  await writeFile(retained, retainedContents);
  const recovery = await probeNativeState(resource, flags, { env });
  assert.equal(recovery.ownership, 'pre-existing');
  assert.equal(recovery.retained, true);
  assert.equal(JSON.stringify(recovery).includes(privateValue), false);
  assert.equal(await readFile(retained, 'utf8'), retainedContents);
});

test('native preflight protects unrelated resumable sessions and qualified retained recovery', async (t) => {
  const { session, retained, resource, flags, env } = await nativeFixture(t);
  const identity = { sandboxName: 'other', sandboxIdentityFingerprint: null, gatewayName: 'nemoclaw-9090', gatewayPort: 9090, lifecycleGeneration: 'fixture-generation', createAttemptNonce: 'a'.repeat(62) };
  await writeFile(session, JSON.stringify({ version: 1, status: 'in_progress', sandboxName: 'other', resumable: true }));
  assert.equal((await probeNativeState(resource, flags, { env })).session, true);
  await writeFile(session, JSON.stringify({ version: 1, status: 'recovery_required', sandboxName: 'other', resumable: false, cancellationRecovery: identity }));
  assert.equal((await probeNativeState(resource, flags, { env })).status, 'failed');
  await writeFile(retained, JSON.stringify({ schemaVersion: 1, unresolved: [{ sandboxName: 'other' }] }));
  assert.equal((await probeNativeState(resource, flags, { env })).status, 'failed');
  await writeFile(retained, JSON.stringify({ schemaVersion: 1, unresolved: [identity] }));
  assert.equal((await probeNativeState(resource, flags, { env })).status, 'passed');
});

test('native preflight rejects malformed or oversized state and unavailable schema exports', async (t) => {
  const { registry, root, resource, flags, env } = await nativeFixture(t);
  await writeFile(registry, '{invalid');
  assert.equal((await probeNativeState(resource, flags, { env })).status, 'blocked');
  await writeFile(registry, ' '.repeat(2 * 1024 * 1024 + 1));
  assert.equal((await probeNativeState(resource, flags, { env })).errorCode, 'NATIVE_STATE_OUTPUT_LIMIT');
  await rm(registry);
  await writeFile(path.join(root, 'dist/lib/state/registry/persistence.js'), 'exports.REGISTRY_FILE = null;\n');
  assert.equal((await probeNativeState(resource, flags, { env })).errorCode, 'NATIVE_STATE_UNSUPPORTED');
});

test('native cleanup refuses changed HOME or unowned lifecycle evidence without commands', async (t) => {
  const { resource, flags, env } = await nativeFixture(t);
  let calls = 0;
  const command = async () => { calls += 1; throw new Error('must not execute'); };
  await cleanupSandbox(resource, flags, command, { env: { ...env, HOME: env.HOME + '-changed' } });
  assert.equal(resource.stages.cleanup.errorCode, 'NATIVE_OWNERSHIP_UNVERIFIED');
  assert.equal(calls, 0);
  resource.nativeState.ownership = 'pre-existing';
  delete resource.stages.cleanup;
  await cleanupSandbox(resource, flags, command, { env });
  assert.equal(calls, 0);
});

test('native retained refusal preserves evidence and never falls back to raw deletion', async (t) => {
  const { retained, resource, flags, env } = await nativeFixture(t);
  const contents = JSON.stringify({ schemaVersion: 1, unresolved: [{ sandboxName: 'fixture' }] });
  await writeFile(retained, contents);
  const calls = [];
  await cleanupSandbox(resource, flags, async (argv, options) => {
    calls.push(argv);
    if (argv[1] === '-e') return run(argv, options);
    assert.deepEqual(argv.slice(2), ['sandbox', 'destroy', 'fixture', '--yes', '--no-cleanup-gateway']);
    return { code: 1, signal: null, stdout: '', stderr: 'retained identity could not be selected', durationMs: 1 };
  }, { env });
  assert.equal(resource.stages.cleanup.status, 'failed');
  assert.equal(resource.nativeState.ownership, 'owned');
  assert.equal(calls.some((argv) => argv[0] === 'openshell'), false);
  assert.equal(await readFile(retained, 'utf8'), contents);
});

test('native destroy success still requires reconciliation and verified remote absence', async (t) => {
  const { registry, resource, flags, env } = await nativeFixture(t);
  await writeFile(registry, JSON.stringify({ sandboxes: { fixture: { name: 'fixture' } } }));
  let removeRegistry = false;
  const command = async (argv, options) => {
    if (argv[1] === '-e') return run(argv, options);
    if (argv[0] === 'openshell') return { code: 1, signal: null, stdout: 'sandbox fixture not found', stderr: '', durationMs: 1 };
    if (removeRegistry) await rm(registry);
    return { code: 0, signal: null, stdout: '', stderr: '', durationMs: 1 };
  };
  await cleanupSandbox(resource, flags, command, { env });
  assert.equal(resource.stages.cleanup.errorCode, 'NATIVE_STATE_REMAINS');
  delete resource.stages.cleanup;
  removeRegistry = true;
  await cleanupSandbox(resource, flags, command, { env });
  assert.equal(resource.stages.cleanup.status, 'passed');
  assert.equal(resource.stages.cleanup.remoteAbsent, true);
  assert.equal(resource.stages.cleanup.nativeState.ownership, 'available');
});

test('native cleanup can verify a no-op when interrupted before creating either resource', async (t) => {
  const { resource, flags, env } = await nativeFixture(t);
  await cleanupSandbox(resource, flags, async (argv, options) => {
    if (argv[1] === '-e') return run(argv, options);
    assert.equal(argv[0], 'openshell');
    assert.deepEqual(argv.slice(1), ['sandbox', 'get', '-g', 'nemoclaw-9090', 'fixture']);
    return { code: 1, signal: null, stdout: 'sandbox fixture not found', stderr: '', durationMs: 1 };
  }, { env });
  assert.equal(resource.stages.cleanup.status, 'passed');
  assert.equal(resource.stages.cleanup.skippedDestroy, true);
});

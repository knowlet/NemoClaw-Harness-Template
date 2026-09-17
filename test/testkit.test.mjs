import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createAdapter, createInferenceClient, AdapterError } from '../src/index.mjs';
import { SUITE_VERSION, defineSuite, runSuite, createMockInferenceServer, toJUnit } from '../src/testkit.mjs';
const suite = (expect = { stdout: 'OK' }) => ({ version: SUITE_VERSION, name: 'contract', cases: [{ name: 'basic', task: 'task-private', expect }] });
const good = async () => ({ stdout: 'OK', stderr: '', exitCode: 0 });
async function temp(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'testkit-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('suite defensively copies and freezes input', () => {
  const data = suite(); const validated = defineSuite(data); data.cases[0].task = 'changed';
  assert.equal(validated.cases[0].task, 'task-private'); assert.ok(Object.isFrozen(validated.cases[0].expect));
});
for (const [label, change] of [
  ['unknown version', (s) => { s.version = 'v99'; }],
  ['empty suite', (s) => { s.cases = []; }],
  ['executable hooks', (s) => { s.setup = 'evil'; }],
  ['duplicate case names', (s) => { s.cases.push(structuredClone(s.cases[0])); }],
  ['unknown assertion', (s) => { s.cases[0].expect = { regex: '.*' }; }],
  ['ambiguous assertion', (s) => { s.cases[0].expect = { stdout: 'x', includes: 'x' }; }],
  ['invalid timeout', (s) => { s.cases[0].timeoutMs = -1; }],
  ['NUL task', (s) => { s.cases[0].task = 'x\0y'; }],
]) test(`suite rejects ${label}`, () => { const data = suite(); change(data); assert.throws(() => defineSuite(data), { code: 'INVALID_SUITE' }); });

test('successful suite has no sandbox claim and never emits task/output bodies', async () => {
  const report = await runSuite(suite(), { invoke: good });
  assert.equal(report.ok, true); assert.equal(report.passed, 1); assert.equal(report.sandboxVerified, false);
  assert.doesNotMatch(JSON.stringify(report), /task-private|"stdout"/); assert.match(report.cases[0].stdoutSha256, /^[0-9a-f]{64}$/);
});
test('mismatch fails and does not hide later cases', async () => {
  const data = suite({ stdout: 'private-expected' }); data.cases.push({ name: 'later', task: 'x', expect: { includes: 'OK' } });
  const report = await runSuite(data, { invoke: good });
  assert.equal(report.failed, 1); assert.equal(report.passed, 1); assert.equal(report.ok, false);
  assert.doesNotMatch(JSON.stringify(report), /private-expected/);
});
test('expected failure code is checked without exposing exception messages', async () => {
  const report = await runSuite(suite({ errorCode: 'PROCESS_FAILED' }), { invoke: async () => { throw new AdapterError('PROCESS_FAILED', 'secret-value'); } });
  assert.equal(report.ok, true); assert.doesNotMatch(JSON.stringify(report), /secret-value/);
});
test('arbitrary bridge exceptions are sanitized', async () => {
  const report = await runSuite(suite(), { invoke: async () => { throw new Error('private-value'); } });
  assert.equal(report.cases[0].errorCode, 'INVOCATION_FAILED'); assert.doesNotMatch(JSON.stringify(report), /private-value/);
});
test('malformed invocation results cannot pass', async () => {
  const report = await runSuite(suite(), { invoke: async () => ({ stdout: 'OK' }) });
  assert.equal(report.ok, false); assert.equal(report.cases[0].errorCode, 'INVALID_RESULT');
});
test('custom bridge deadline is bounded even without cooperation', async () => {
  const data = suite({ errorCode: 'TIMEOUT' }); data.cases[0].timeoutMs = 25;
  const report = await runSuite(data, { invoke: () => new Promise(() => {}) });
  assert.equal(report.ok, true);
});
test('cancellation is not converted into an expected-error success', async () => {
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), 30);
  const data = suite({ errorCode: 'ABORTED' }); data.cases.push({ name: 'never', task: 'x', expect: { stdout: 'OK' } });
  try {
    const report = await runSuite(data, { signal: c.signal, invoke: () => new Promise(() => {}) });
    assert.equal(report.ok, false); assert.equal(report.cancelled, 2);
  } finally { clearTimeout(timer); }
});
test('pre-cancelled suites do not invoke a bridge', async () => {
  const c = new AbortController(); c.abort(); let count = 0;
  const report = await runSuite(suite(), { signal: c.signal, invoke: async () => { count++; return good(); } });
  assert.equal(count, 0); assert.equal(report.ok, false);
});
test('exactly one backend is required', async () => {
  await assert.rejects(runSuite(suite(), {}), { code: 'INVALID_SUITE_OPTIONS' });
  await assert.rejects(runSuite(suite(), { adapter: createAdapter(), invoke: good }), { code: 'INVALID_SUITE_OPTIONS' });
});
test('real process adapter handles Unicode and literal shell syntax', async (t) => {
  const dir = await temp(t); const adapter = structuredClone(createAdapter());
  adapter.runtime.command = [process.execPath, fileURLToPath(new URL('../examples/echo/agent.mjs', import.meta.url))];
  const task = '繁體 🦖 $(touch NOT_CREATED); "quote"';
  const report = await runSuite({ version: SUITE_VERSION, name: 'process', cases: [{ name: 'literal', task, expect: { stdout: `Echo: ${task}\n` } }] }, { adapter, cwd: dir, home: dir });
  assert.equal(report.ok, true); await assert.rejects(readFile(path.join(dir, 'NOT_CREATED')), { code: 'ENOENT' });
});
test('JUnit escapes names and records failures and cancellation', async () => {
  const data = suite(); data.name = 'A<&"'; data.cases[0].name = 'x&y';
  const report = await runSuite(data, { invoke: async () => ({ stdout: 'bad', stderr: '', exitCode: 0 }) });
  const xml = toJUnit(report); assert.match(xml, /A&lt;&amp;&quot;/); assert.match(xml, /failures="1"/); assert.match(xml, /STDOUT_MISMATCH/);
  assert.doesNotMatch(xml, /task-private|>bad</);
});
test('real loopback fixture serves text, tool-call, and final responses', async (t) => {
  const mock = await createMockInferenceServer({ replies: ['first', { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"test.txt"}' } }] }, 'done'] });
  t.after(() => mock.close());
  const client = createInferenceClient({ model: 'fixture-model', baseUrl: mock.baseUrl, development: true });
  const first = await client.chat([{ role: 'user', content: 'sensitive-task' }]); assert.equal(first.choices[0].message.content, 'first');
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const call = await client.chat([{ role: 'user', content: 'read' }], { tools }); assert.equal(call.choices[0].message.tool_calls[0].function.name, 'read_file');
  const final = await client.chat([{ role: 'tool', tool_call_id: 'call-1', content: 'file data' }]); assert.equal(final.choices[0].message.content, 'done');
  assert.equal(mock.requests.length, 3); assert.equal(mock.requests[1].toolCount, 1); assert.equal(mock.requests[0].placeholderAuth, true);
  assert.doesNotMatch(JSON.stringify(mock.requests), /sensitive-task|file data/);
  await assert.rejects(client.chat([{ role: 'user', content: 'exhausted' }]));
});
test('CLI requires explicit execution and returns machine-readable failures', async (t) => {
  const dir = await temp(t); const adapter = structuredClone(createAdapter());
  adapter.runtime.command = [process.execPath, fileURLToPath(new URL('../examples/echo/agent.mjs', import.meta.url))];
  const data = suite({ stdout: 'Echo: task-private\n' });
  await writeFile(path.join(dir, 'adapter.json'), JSON.stringify(adapter)); await writeFile(path.join(dir, 'suite.json'), JSON.stringify(data));
  const cli = fileURLToPath(new URL('../bin/nha.mjs', import.meta.url));
  const run = (extra) => spawnSync(process.execPath, [cli, 'test', 'suite.json', '--adapter', 'adapter.json', ...extra], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(run([]).status, 0);
  const ok = run(['--allow-host', '--json', 'report.json', '--junit', 'report.xml']);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).passed, 1);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')).ok, true);
  assert.match(await readFile(path.join(dir, 'report.xml'), 'utf8'), /<testsuite/);
  data.cases[0].expect.stdout = 'different'; await writeFile(path.join(dir, 'suite.json'), JSON.stringify(data));
  const bad = run(['--allow-host']); assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stdout).failed, 1);
  assert.notEqual(run(['--allow-host', '--json', 'report.json']).status, 0); // Never overwrite existing evidence.
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, INFERENCE_URL, createAdapter, defineAdapter, loadAdapter, assertManagedFile, buildEnvironment, runHarness, createInferenceClient, digest, assertImageDigest, buildOpenShellCommand, renderPolicy, renderDockerfile, renderDeepSeekPatch, scaffold } from '../src/index.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const fresh = () => structuredClone(createAdapter('test-agent', 'test-model'));
const code = (expected) => (error) => error.code === expected;
const temp = async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nha-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
function withCommand(script) {
  const adapter = fresh();
  adapter.runtime.command = [process.execPath, '-e', script];
  return adapter;
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); return new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}/v1`;
}

test('manifest copies and deeply freezes caller data', () => {
  const original = fresh();
  const result = defineAdapter(original);
  original.runtime.command[0] = '/evil';
  assert.notEqual(result.runtime.command[0], '/evil');
  assert.throws(() => { result.runtime.command.push('bad'); }, TypeError);
});
for (const [label, mutate] of [
  ['unknown schema', (a) => { a.apiVersion = 'upstream/v99'; }],
  ['unknown fields', (a) => { a.hook = 'exec'; }],
  ['official identity', (a) => { a.metadata.unofficial = false; }],
  ['invalid name', (a) => { a.metadata.name = '../x'; }],
  ['shell string', (a) => { a.runtime.command = 'sh -c echo'; }],
  ['relative executable', (a) => { a.runtime.command = ['node']; }],
  ['NUL argv', (a) => { a.runtime.command.push('\0'); }],
  ['negative timeout', (a) => { a.runtime.timeoutMs = -1; }],
  ['infinite output', (a) => { a.runtime.maxOutputBytes = Infinity; }],
  ['unknown task transport', (a) => { a.runtime.taskInput = 'shell'; }],
  ['direct provider route', (a) => { a.inference.baseUrl = 'https://api.deepseek.com/v1'; }],
  ['URL credentials', (a) => { a.inference.baseUrl = 'https://secret@inference.local/v1'; }],
  ['state traversal', (a) => { a.state.home = '/sandbox/../etc'; }],
  ['Dockerfile injection', (a) => { a.state.home = '/sandbox/a;touch${IFS}/tmp/pwn'; }],
  ['nested workspace', (a) => { a.state.workspace = `${a.state.home}/work`; }],
  ['snapshot traversal', (a) => { a.state.persist = ['../.ssh']; }],
  ['state class overlap', (a) => { a.state.prohibit = ['sessions/secret']; }],
  ['credential env', (a) => { a.env = { OPENAI_API_KEY: 'do-not-forward' }; }],
  ['loader env', (a) => { a.env = { NODE_OPTIONS: '--import=evil' }; }],
  ['custom secret env', (a) => { a.env = { NHA_CUSTOM_API_KEY: 'secret' }; }],
  ['DSH home mismatch', (a) => { a.env = { DSH_HOME: '/tmp' }; }],
]) test(`reject ${label}`, () => { const adapter = fresh(); mutate(adapter); assert.throws(() => defineAdapter(adapter), code('INVALID_MANIFEST')); });

test('environment strips keys, tokens, loader hooks, and ambient model overrides', () => {
  const result = buildEnvironment(fresh(), { OPENAI_API_KEY: 'sensitive', GITHUB_TOKEN: 'sensitive', AWS_SECRET_ACCESS_KEY: 'sensitive', NODE_OPTIONS: '--import=evil', LD_PRELOAD: '/evil', NHA_INFERENCE_BASE_URL: 'https://evil', HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' });
  assert.equal(result.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(result.NODE_EXTRA_CA_CERTS, '/etc/ca.pem');
  assert.equal(result.NHA_INFERENCE_BASE_URL, INFERENCE_URL);
  assert.equal(result.NHA_INFERENCE_TOKEN, 'openshell');
  assert.equal(result.NODE_USE_ENV_PROXY, '1');
  assert.ok(!JSON.stringify(result).includes('sensitive'));
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.equal(result.LD_PRELOAD, undefined);
});
test('stdin treats shell metacharacters as literal task data', async (t) => {
  const dir = await temp(t);
  const task = '$(touch SHOULD_NOT_EXIST); `whoami`\n--patch /evil';
  const result = await runHarness(withCommand('process.stdin.pipe(process.stdout)'), task, { cwd: dir, home: dir });
  assert.equal(result.stdout, task);
  assert.equal(result.exitCode, 0);
  await assert.rejects(readFile(path.join(dir, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
});
test('argv task stays one argument', async (t) => {
  const dir = await temp(t), adapter = withCommand('process.stdout.write(JSON.stringify(process.argv.slice(1)))');
  adapter.runtime.taskInput = 'argv';
  const task = 'hello; $(whoami) "quoted"';
  const result = await runHarness(adapter, task, { cwd: dir });
  assert.deepEqual(JSON.parse(result.stdout), [task]);
});
test('argv leading flags are refused', async () => {
  const adapter = fresh(); adapter.runtime.taskInput = 'argv';
  await assert.rejects(runHarness(adapter, '--patch evil'), code('INVALID_TASK'));
});
test('nonzero exits fail without leaking child output', async (t) => {
  const dir = await temp(t);
  await assert.rejects(runHarness(withCommand('console.error("DO_NOT_LEAK");process.exit(7)'), 'test', { cwd: dir }), (error) => error.code === 'PROCESS_FAILED' && !JSON.stringify(error).includes('DO_NOT_LEAK'));
});
test('spawn failure is bounded and sanitized', async (t) => {
  const adapter = fresh(); adapter.runtime.command = ['/not/an/executable'];
  await assert.rejects(runHarness(adapter, 'test', { cwd: await temp(t) }), code('SPAWN_FAILED'));
});
test('timeout kills a hanging subprocess', async (t) => {
  const adapter = withCommand('setInterval(()=>{},1000)'); adapter.runtime.timeoutMs = 80;
  await assert.rejects(runHarness(adapter, 'test', { cwd: await temp(t) }), code('TIMEOUT'));
});
test('output limit applies to stdout and stderr together', async (t) => {
  const adapter = withCommand('process.stdout.write("x".repeat(1000));process.stderr.write("y".repeat(1000))'); adapter.runtime.maxOutputBytes = 1500;
  await assert.rejects(runHarness(adapter, 'test', { cwd: await temp(t) }), code('OUTPUT_LIMIT'));
});
test('pre-aborted invocation never spawns', async () => {
  await assert.rejects(runHarness(fresh(), 'test', { signal: AbortSignal.abort() }), code('ABORTED'));
});
test('abort terminates an active invocation', async (t) => {
  const signal = AbortSignal.timeout(80);
  await assert.rejects(runHarness(withCommand('setInterval(()=>{},1000)'), 'test', { cwd: await temp(t), signal }), code('ABORTED'));
});
test('managed file rejects a symlink or writable ancestry', async (t) => {
  const dir = await temp(t), file = path.join(dir, 'adapter.json'), link = path.join(dir, 'link.json');
  await writeFile(file, JSON.stringify(fresh())); await symlink(file, link);
  await assert.rejects(assertManagedFile(link), code('UNTRUSTED_CONFIG'));
  await assert.rejects(assertManagedFile(file), code('UNTRUSTED_CONFIG'));
});
test('JSON load validates schema and rejects oversized documents', async (t) => {
  const file = path.join(await temp(t), 'adapter.json');
  await writeFile(file, JSON.stringify(fresh()));
  assert.equal((await loadAdapter(file)).apiVersion, API_VERSION);
  await writeFile(file, ' '.repeat(65537));
  await assert.rejects(loadAdapter(file), code('INVALID_MANIFEST'));
});
for (const endpoint of ['https://api.openai.com/v1', 'http://inference.local/v1', 'https://inference.local/v1?key=secret', 'https://user:secret@inference.local/v1', 'https://inference.local/v1#bad', 'http://169.254.169.254/v1', 'http://127.0.0.1.evil/v1']) {
  test(`client refuses ${endpoint.replace(/secret/g, 'REDACTED')}`, () => assert.throws(() => createInferenceClient({ model: 'm', baseUrl: endpoint }), code('INVALID_ENDPOINT')));
}
test('development bypass stays loopback-only', () => {
  assert.throws(() => createInferenceClient({ model: 'm', baseUrl: 'http://10.0.0.1/v1', development: true }), code('INVALID_ENDPOINT'));
});
test('real loopback HTTP exercises the client payload and placeholder token', async (t) => {
  let received;
  const baseUrl = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  const client = createInferenceClient({ model: 'm', baseUrl, development: true });
  const reply = await client.chat([{ role: 'user', content: 'Hello' }], { temperature: 0 });
  assert.equal(reply.choices[0].message.content, 'OK');
  assert.equal(received.path, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer openshell');
  assert.equal(received.body.model, 'm');
  assert.equal(received.body.stream, false);
});
test('client rejects unsupported streaming and override options', async () => {
  const client = createInferenceClient({ model: 'm' });
  for (const parameters of [{ stream: true }, { model: 'evil' }, { apiKey: 'secret' }]) await assert.rejects(client.chat([{ role: 'user', content: 'x' }], parameters), code('INVALID_PARAMETERS'));
});
test('client refuses redirects without contacting redirected origin', async (t) => {
  let redirected = false;
  const target = await server(t, (_req, res) => { redirected = true; res.end('{}'); });
  const baseUrl = await server(t, (_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  await assert.rejects(createInferenceClient({ model: 'm', baseUrl, development: true }).chat([{ role: 'user', content: 'x' }]), code('HTTP_ERROR'));
  assert.equal(redirected, false);
});
test('HTTP failure does not expose provider response body', async (t) => {
  const baseUrl = await server(t, (_req, res) => { res.writeHead(403); res.end('PROVIDER_SECRET'); });
  await assert.rejects(createInferenceClient({ model: 'm', baseUrl, development: true }).chat([{ role: 'user', content: 'x' }]), (e) => e.code === 'HTTP_ERROR' && !e.message.includes('PROVIDER_SECRET'));
});
test('client bounds a chunked response', async (t) => {
  const baseUrl = await server(t, (_req, res) => res.end('x'.repeat(1000)));
  await assert.rejects(createInferenceClient({ model: 'm', baseUrl, development: true, maxResponseBytes: 10 }).chat([{ role: 'user', content: 'x' }]), code('RESPONSE_LIMIT'));
});
test('client deadline includes response body transfer', async (t) => {
  const baseUrl = await server(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  await assert.rejects(createInferenceClient({ model: 'm', baseUrl, development: true, timeoutMs: 80 }).chat([{ role: 'user', content: 'x' }]), code('TIMEOUT'));
});
test('invalid JSON and missing choices are sanitized', async (t) => {
  for (const body of ['not JSON', '{}']) {
    const baseUrl = await server(t, (_req, res) => res.end(body));
    await assert.rejects(createInferenceClient({ model: 'm', baseUrl, development: true }).chat([{ role: 'user', content: 'x' }]), code('INVALID_RESPONSE'));
  }
});
test('digest is stable for an identical serialized manifest', () => assert.equal(digest(fresh()), digest(fresh())));
test('OCI digests are required by default, never fabricated', () => {
  assert.throws(() => assertImageDigest('repo:latest'), code('UNPINNED_IMAGE'));
  const image = `ghcr.io/example/harness@sha256:${'a'.repeat(64)}`;
  assert.equal(assertImageDigest(image), image);
  const argv = buildOpenShellCommand({ image, name: 'test', policy: 'policy.yaml', task: 'hello; not-a-shell' });
  assert.equal(argv[0], 'openshell');
  assert.equal(argv.at(-1), 'hello; not-a-shell');
  assert.ok(argv.includes('--managed'));
  assert.ok(argv.includes('--'));
});
test('mutable development images require explicit opt-in', () => {
  assert.throws(() => buildOpenShellCommand({ name: 'x', image: 'repo:dev', policy: 'p', task: 'x' }), code('UNPINNED_IMAGE'));
  assert.ok(buildOpenShellCommand({ name: 'x', image: 'repo:dev', policy: 'p', task: 'x', allowMutableImage: true }).includes('repo:dev'));
});
test('policy denies additional egress and requires Landlock', () => {
  const policy = renderPolicy(fresh());
  assert.ok(policy.includes('network_policies: {}'));
  assert.ok(policy.includes('hard_requirement'));
  assert.ok(!policy.includes('read_write: [/sandbox,'));
});
test('Dockerfile protects config and declares a non-root identity', () => {
  const docker = renderDockerfile(fresh());
  assert.ok(docker.includes('chmod 0444'));
  assert.ok(docker.includes('USER 1000:1000'));
  assert.ok(docker.includes('iproute2'));
  assert.ok(docker.includes('UNOFFICIAL'));
});
test('DeepSeek patch disables writable settings and fixes the route', () => {
  const patch = JSON.parse(renderDeepSeekPatch(fresh()));
  assert.equal(patch.find((row) => row.id === 'settings').disabled, true);
  assert.equal(patch.find((row) => row.id === 'llm-pi-ai').config.providers['nha-managed'].baseURL, INFERENCE_URL);
});
test('fresh scaffold works and never overwrites an existing directory', async (t) => {
  const dir = await temp(t), output = path.join(dir, 'project');
  await scaffold(output, { name: 'example-harness' });
  assert.equal((await loadAdapter(path.join(output, 'adapter.json'))).metadata.name, 'example-harness');
  const result = spawnSync(process.execPath, ['bin/nha.js', 'demo'], { cwd: output, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Echo: Hello/);
  await assert.rejects(scaffold(output), code('DESTINATION_EXISTS'));
});
test('CLI rejects ambiguous execution and invalid commands', () => {
  for (const args of [['not-a-command'], ['exec', 'missing.json', '--task', 'x'], ['--unknown']]) {
    const result = spawnSync(process.execPath, ['bin/nha.js', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
  }
});

test('launch plan task limit counts UTF-8 bytes', () => {
  assert.throws(() => buildOpenShellCommand({ name: 'nha', image: 'test:dev', policy: 'p.yaml', task: '中'.repeat(6000), allowMutableImage: true }), code('INVALID_TASK'));
});
test('DeepSeek generator creates a constrained candidate context without running DSH', async (t) => {
  const dir = path.join(await temp(t), 'candidate');
  const result = spawnSync(process.execPath, ['examples/deepseek/prepare.mjs', dir, 'test-model', `registry.example/dsh@sha256:${'a'.repeat(64)}`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const adapter = await loadAdapter(path.join(dir, 'adapter.json'));
  assert.equal(adapter.env.DSH_HOME, '/sandbox/.dsh');
  assert.equal(adapter.runtime.command[1], '/opt/nha/deepseek-launch.mjs');
  const policy = await readFile(path.join(dir, 'policy.yaml'), 'utf8');
  assert.ok(!policy.includes('read_write: [/sandbox/.dsh,'));
  assert.match(policy, /hard_requirement/);
  assert.match(await readFile(path.join(dir, 'Dockerfile'), 'utf8'), /verify-build.mjs/);
  const review = JSON.parse(await readFile(path.join(dir, 'source-review.json'), 'utf8'));
  assert.equal(review.status, 'experimental-not-qualified');
});
test('DeepSeek generator rejects mutable images before writing a context', async (t) => {
  const dir = path.join(await temp(t), 'candidate');
  const result = spawnSync(process.execPath, ['examples/deepseek/prepare.mjs', dir, 'test-model', 'dsh:latest'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNPINNED_IMAGE/);
  await assert.rejects(readFile(path.join(dir, 'adapter.json')), { code: 'ENOENT' });
});

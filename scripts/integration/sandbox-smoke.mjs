// UNOFFICIAL: copied into a disposable test image or an actual NemoClaw sandbox.
// This proves specific checks only. The upstream model is a deterministic fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const { createInferenceClient, runSuite, assertManagedFile } = await import(new URL('./src/index.mjs', import.meta.url));
const mode = process.argv[2];
assert.ok(['embedded', 'byoc'].includes(mode));
const checks = [];
assert.notEqual(process.getuid(), 0); checks.push('non-root');
assert.ok(!Object.values(process.env).includes('fixture-only-not-a-secret')); checks.push('upstream-sentinel-absent');
const tmp = await mkdtemp('/tmp/harness-integration-');
try {
  const adapter = JSON.parse(await readFile(path.join(root, 'adapter.json'), 'utf8'));
  adapter.runtime.command = [process.execPath, path.join(root, 'agent.mjs')];
  const suite = JSON.parse(await readFile(path.join(root, 'test/suite.json'), 'utf8'));
  const report = await runSuite(suite, { adapter, cwd: tmp, home: tmp });
  assert.equal(report.ok, true, JSON.stringify(report)); checks.push('harness-contract');
  const response = await createInferenceClient({ model: 'fixture-model', timeoutMs: 15000 }).chat([{ role: 'user', content: 'Return NHA_LIVE_OK' }]);
  assert.equal(response.choices[0].message.content, 'NHA_LIVE_OK'); checks.push('managed-inference-fixture');
  if (mode === 'byoc') {
    await assertManagedFile('/etc/nha/adapter.json'); checks.push('immutable-config');
    // This world-readable/writable directory exists in the image but NOT in policy.
    assert.equal((await stat('/policy-probe')).mode & 0o777, 0o777);
    const denied = (e) => ['EACCES', 'EPERM'].includes(e.code);
    await assert.rejects(readFile('/policy-probe/readable.txt'), denied);
    await assert.rejects(writeFile('/policy-probe/write.txt', 'probe'), denied);
    checks.push('filesystem-read-write-denied');
    const proxy = new URL(process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy);
    assert.equal(proxy.protocol, 'http:');
    const status = await new Promise((resolve, reject) => {
      const req = request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'example.com:443', headers: { host: 'example.com:443' } });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('PROXY_TIMEOUT'))); req.end();
    });
    assert.equal(status, 403); checks.push('undeclared-egress-http403');
  }
  console.log(JSON.stringify({ unofficial: true, mode, realSandbox: true, realModel: false, uid: process.getuid(), node: process.version, checks, contract: report }));
} finally { await rm(tmp, { recursive: true, force: true }); }

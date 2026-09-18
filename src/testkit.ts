// TypeScript source of truth; declarations are emitted by tsc.
/** UNOFFICIAL, dependency-free black-box harness test kit. Not sandbox attestation. */
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { AdapterError, defineAdapter, digest, runHarness } from './sdk.js';
export const SUITE_VERSION = 'harness-suite/v1' as const;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && Buffer.byteLength(v) <= max && !v.includes('\0');
function fields(v, allowed) {
  return object(v) && Object.keys(v).every((k) => allowed.includes(k));
}
function invalid() { throw new AdapterError('INVALID_SUITE', 'Invalid harness suite; see the versioned test-kit contract'); }
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
export function defineSuite(input) {
  if (!fields(input, ['version', 'name', 'cases']) || input.version !== SUITE_VERSION || !text(input.name, 128) || !input.name) invalid();
  if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 100) invalid();
  const names = new Set();
  for (const c of input.cases) {
    if (!fields(c, ['name', 'task', 'expect', 'timeoutMs']) || !text(c.name, 128) || !c.name || names.has(c.name)) invalid();
    names.add(c.name);
    if (!text(c.task, 1048576) || !c.task) invalid();
    if (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1 || c.timeoutMs > 3600000)) invalid();
    const e = c.expect;
    if (!fields(e, ['stdout', 'includes', 'errorCode']) || Object.keys(e).length !== 1) invalid();
    if ('stdout' in e && !text(e.stdout, 16777216)) invalid();
    if ('includes' in e && (!text(e.includes, 16384) || !e.includes)) invalid();
    if ('errorCode' in e && !/^[A-Z][A-Z0-9_]{0,63}$/.test(e.errorCode)) invalid();
  }
  return freeze(JSON.parse(JSON.stringify(input)));
}

/** Supply either an adapter or a custom invocation bridge, never both. Reports omit task/output/error messages. */
export async function runSuite(input, options = {}) {
  const suite = defineSuite(input);
  if (Boolean(options.adapter) === Boolean(options.invoke) || (options.invoke && typeof options.invoke !== 'function')) {
    throw new AdapterError('INVALID_SUITE_OPTIONS', 'Supply exactly one adapter or invoke function');
  }
  const adapter = options.adapter ? defineAdapter(options.adapter) : null;
  const started = performance.now();
  const results = [];
  for (const c of suite.cases) {
    const start = performance.now();
    let output, errorCode, failure;
    if (options.signal?.aborted) {
      results.push({ name: c.name, status: 'cancelled', durationMs: 0, failure: 'ABORTED' });
      continue;
    }
    const controller = new AbortController();
    const timeoutMs = c.timeoutMs ?? adapter?.runtime.timeoutMs ?? 120000;
    let timer, abort;
    const cancellation = new Promise((_, reject) => {
      abort = () => {
        reject(new AdapterError('ABORTED', 'Invocation cancelled'));
        controller.abort();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      timer = setTimeout(() => {
        reject(new AdapterError('TIMEOUT', 'Invocation deadline exceeded'));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const invocation = adapter ? runHarness(adapter, c.task, {
        cwd: options.cwd, home: options.home, parentEnv: options.parentEnv, signal: controller.signal,
      }) : Promise.resolve().then(() => options.invoke(c.task, { signal: controller.signal, caseName: c.name }));
      output = await Promise.race([invocation, cancellation]);
      if (!output || typeof output.stdout !== 'string' || typeof output.stderr !== 'string' || output.exitCode !== 0) {
        errorCode = 'INVALID_RESULT'; output = undefined;
      } else if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 16777216) {
        errorCode = 'OUTPUT_LIMIT'; output = undefined;
      }
    } catch (error) {
      errorCode = error instanceof AdapterError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'INVOCATION_FAILED';
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort();
    }
    const cancelled = options.signal?.aborted === true;
    if (cancelled) failure = 'ABORTED';
    else if ('errorCode' in c.expect) { if (errorCode !== c.expect.errorCode) failure = 'ERROR_MISMATCH'; }
    else if (errorCode) failure = errorCode;
    else if ('stdout' in c.expect && output.stdout !== c.expect.stdout) failure = 'STDOUT_MISMATCH';
    else if ('includes' in c.expect && !output.stdout.includes(c.expect.includes)) failure = 'STDOUT_MISMATCH';
    results.push({ name: c.name, status: cancelled ? 'cancelled' : failure ? 'failed' : 'passed', durationMs: Math.round(performance.now() - start),
      ...(failure ? { failure } : {}), ...(errorCode ? { errorCode } : {}),
      ...(output ? { stdoutSha256: digest(output.stdout), stdoutBytes: Buffer.byteLength(output.stdout), stderrBytes: Buffer.byteLength(output.stderr) } : {}),
    });
  }
  const count = (status) => results.filter((c) => c.status === status).length;
  return { version: SUITE_VERSION, name: suite.name, unofficial: true, suiteSha256: digest(suite),
    execution: adapter ? 'process' : 'custom-invoke', sandboxVerified: false,
    passed: count('passed'), failed: count('failed'), cancelled: count('cancelled'),
    ok: results.every((c) => c.status === 'passed'), durationMs: Math.round(performance.now() - started), cases: results };
}

/** Loopback-only deterministic OpenAI-compatible fixture. It is NOT a model or a managed gateway. */
export async function createMockInferenceServer({ replies = ['MOCK_OK'], model = 'fixture-model' } = {}) {
  if (!Array.isArray(replies) || !replies.length || !replies.every((r) => typeof r === 'string' || (object(r) && (typeof r.content === 'string' || r.content === null) && (!r.tool_calls || Array.isArray(r.tool_calls))))) invalid();
  const queue = JSON.parse(JSON.stringify(replies));
  const requests = [];
  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: model, object: 'model' }] });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: 'fixture_not_found' });
    let raw = '';
    try {
      for await (const b of req) { raw += b; if (Buffer.byteLength(raw) > 1048576) { json(413, { error: 'fixture_size_limit' }); return; } }
      const body = JSON.parse(raw);
      if (body.stream === true) return json(400, { error: 'fixture_streaming_unsupported' });
      requests.push({ model: body.model, messageCount: body.messages?.length ?? 0, toolCount: body.tools?.length ?? 0, placeholderAuth: req.headers.authorization === 'Bearer openshell' });
      if (!queue.length) return json(503, { error: 'fixture_exhausted' });
      const reply = queue.shift();
      const message = typeof reply === 'string' ? { role: 'assistant', content: reply } : { ...reply, role: 'assistant' };
      json(200, { id: `fixture-${requests.length}`, object: 'chat.completion', created: 0, model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
    } catch { if (!res.writableEnded) json(400, { error: 'fixture_bad_request' }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    get requests() { return structuredClone(requests); },
    close: () => new Promise((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); server.closeAllConnections(); }) };
}

/** JUnit output contains only names, status codes, and timings; never task/output bodies. */
export function toJUnit(report) {
  const escape = (v) => String(v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  const cases = report.cases.map((c) => {
    const status = c.status === 'passed' ? '' : c.status === 'cancelled' ? '<skipped message="ABORTED"/>' : `<failure message="${escape(c.failure)}"/>`;
    return `  <testcase name="${escape(c.name)}" time="${c.durationMs / 1000}">${status}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escape(report.name)}" tests="${report.cases.length}" failures="${report.failed}" skipped="${report.cancelled}" time="${report.durationMs / 1000}">\n${cases}\n</testsuite>\n`;
}

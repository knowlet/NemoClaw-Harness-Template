// UNOFFICIAL integration-only fixture. NOT an LLM. No real credentials accepted or logged.
import { createServer } from 'node:http';
const model = 'fixture-model';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1048576) { res.writeHead(413); res.end(); return; } }
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400); res.end(); return; }
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'test-fixture' }] }));
    return;
  }
  const base = { id: 'fixture-completion', created: 0, model };
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'NHA_LIVE_OK' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'NHA_LIVE_OK' }, finish_reason: 'stop' }] }));
  }
});
server.listen(18080, '0.0.0.0', () => console.log('Deterministic integration fixture listening; NOT a real model.'));
process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });

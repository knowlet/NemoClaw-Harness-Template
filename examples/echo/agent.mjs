// UNOFFICIAL deterministic example: this echoes input; it is not an LLM.
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 1048576) throw new Error('Task exceeds 1 MiB');
  chunks.push(chunk);
}
const task = Buffer.concat(chunks, bytes).toString('utf8');
process.stdout.write(`Echo: ${task}\n`);

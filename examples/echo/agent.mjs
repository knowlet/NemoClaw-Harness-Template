// UNOFFICIAL deterministic example: this echoes input; it is not an LLM.
let task = '';
for await (const chunk of process.stdin) {
  task += chunk;
  if (Buffer.byteLength(task) > 1048576) throw new Error('Task exceeds 1 MiB');
}
process.stdout.write(`Echo: ${task}\n`);

// UNOFFICIAL. Run only inside a configured sandbox with the managed route available.
import { createInferenceClient } from '../src/index.mjs';
const client = createInferenceClient({ model: process.env.NHA_MODEL ?? 'managed-model' });
let task = '';
for await (const chunk of process.stdin) {
  task += chunk;
  if (Buffer.byteLength(task) > 1048576) throw new Error('Task exceeds 1 MiB');
}
try {
  const response = await client.chat([{ role: 'user', content: task }]);
  process.stdout.write(`${response.choices[0].message.content ?? ''}\n`);
} catch (error) {
  console.error(error.code ?? 'INFERENCE_FAILED');
  process.exitCode = 1;
}

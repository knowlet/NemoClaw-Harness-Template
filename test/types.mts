import { createAdapter, defineAdapter, runHarness, createInferenceClient, buildOpenShellCommand } from '@knowlet/nemoclaw-harness-sdk';
const adapter = defineAdapter(createAdapter('typed-harness'));
const pending: Promise<{ stdout: string }> = runHarness(adapter, 'hello', { cwd: '/tmp' });
void pending;
const client = createInferenceClient({ model: 'm' });
void client.chat([{ role: 'user', content: 'hello' }], { temperature: 0 });
// @ts-expect-error streaming is explicitly not supported
void client.chat([{ role: 'user', content: 'hello' }], { stream: true });
// @ts-expect-error readonly manifest
adapter.runtime.command.push('unsafe');
const argv: string[] = buildOpenShellCommand({ name: 'x', image: 'repo:dev', policy: 'p', task: 'x', allowMutableImage: true });
void argv;

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
import { runSuite, SUITE_VERSION, createMockInferenceServer, type SuiteReport } from '@knowlet/nemoclaw-harness-sdk/testing';
const report: Promise<SuiteReport> = runSuite({ version: SUITE_VERSION, name: 'typed-suite', cases: [{ name: 'echo', task: 'x', expect: { stdout: 'x' } }] }, { adapter });
void report; void createMockInferenceServer;
// @ts-expect-error cannot mix two execution backends
void runSuite({ version: SUITE_VERSION, name: 'test', cases: [] }, { adapter, invoke: async () => ({ stdout: '', stderr: '', exitCode: 0 }) });

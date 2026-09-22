import {
  VERSION,
  AdapterError,
  createAdapter,
  defineAdapter,
  runHarness,
  createInferenceClient,
  buildOpenShellCommand,
  defineNativeAgent,
  renderNativeLauncher,
  renderNativePackage,
  scaffoldNativeAgent,
  readNativePackage,
  installNativeAgent,
  verifyNativeAgent,
  type NativeAgentDefinition,
  type NativeVerificationReport,
  type NativeInstallResult,
  type ChatResponse,
} from '@knowlet/nemoclaw-harness-sdk';

const exactVersion: '0.3.0' = VERSION;
void exactVersion;
const adapter = defineAdapter(createAdapter('typed-harness'));
const pending: Promise<{ stdout: string }> = runHarness(adapter, 'hello', { cwd: '/tmp' });
void pending;
const client = createInferenceClient({ model: 'm' });
const response: Promise<ChatResponse> = client.chat([{ role: 'user', content: 'hello' }], { temperature: 0 });
void response;
const error: AdapterError = new AdapterError('TEST', 'test');
const errorCode: string = error.code;
void errorCode;
// @ts-expect-error streaming is explicitly not supported
void client.chat([{ role: 'user', content: 'hello' }], { stream: true });
// @ts-expect-error readonly manifest
adapter.runtime.command.push('unsafe');
const argv: string[] = buildOpenShellCommand({ name: 'x', image: 'repo:dev', policy: 'p', task: 'x', allowMutableImage: true });
void argv;

const native: NativeAgentDefinition = defineNativeAgent({ name: 'typed-native' });
const binaryPath: string = native.binaryPath;
void binaryPath;
const launcher: string = renderNativeLauncher(native);
void launcher;
const verification: Promise<NativeVerificationReport> = verifyNativeAgent({
  nemoclawRoot: '/tmp/NemoClaw',
  name: native.name,
});
void verification;
const files: Readonly<Record<string, string>> = renderNativePackage(native);
const scaffold: Promise<{ directory: string; files: string[]; agent: NativeAgentDefinition }> = scaffoldNativeAgent('/tmp/native', native);
const pack: Promise<{ directory: string; agent: Record<string, unknown>; metadata: Record<string, unknown> }> = readNativePackage('/tmp/native');
const installation: Promise<NativeInstallResult> = installNativeAgent('/tmp/native', { nemoclawRoot: '/tmp/NemoClaw', replace: true });
void files; void scaffold; void pack; void installation;
// @ts-expect-error only supported native harness modes are accepted
void defineNativeAgent({ name: 'typed-native', harness: 'other' });
// @ts-expect-error native installation requires a target checkout
void installNativeAgent('/tmp/native', {});
// @ts-expect-error allowUnsupportedUpstream is a boolean
void verifyNativeAgent({ nemoclawRoot: '/tmp/NemoClaw', name: 'typed-native', allowUnsupportedUpstream: 'true' });

import { runSuite, SUITE_VERSION, createMockInferenceServer, toJUnit, type SuiteReport, type MockInferenceServer } from '@knowlet/nemoclaw-harness-sdk/testing';
const report: Promise<SuiteReport> = runSuite({ version: SUITE_VERSION, name: 'typed-suite', cases: [{ name: 'echo', task: 'x', expect: { stdout: 'x' } }] }, { adapter });
const junit: Promise<string> = report.then(toJUnit);
const server: Promise<MockInferenceServer> = createMockInferenceServer({ replies: [{ content: null, tool_calls: [] }] });
const custom: Promise<SuiteReport> = runSuite({ version: SUITE_VERSION, name: 'custom', cases: [] }, { invoke: async (task, { signal, caseName }) => {
  const aborted: boolean = signal.aborted;
  const name: string = caseName;
  void aborted; void name;
  return { stdout: task, stderr: '', exitCode: 0 };
} });
void junit; void server; void custom;
// @ts-expect-error cannot mix two execution backends
void runSuite({ version: SUITE_VERSION, name: 'test', cases: [] }, { adapter, invoke: async () => ({ stdout: '', stderr: '', exitCode: 0 }) });
// @ts-expect-error a suite requires an execution backend
void runSuite({ version: SUITE_VERSION, name: 'test', cases: [] }, {});
// @ts-expect-error invoke results require a numeric exit code
void runSuite({ version: SUITE_VERSION, name: 'test', cases: [] }, { invoke: async () => ({ stdout: '', stderr: '', exitCode: '0' }) });
// @ts-expect-error mock replies require string or null content
void createMockInferenceServer({ replies: [{ content: 42 }] });

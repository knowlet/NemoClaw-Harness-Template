import * as sdk from './sdk.js';
import * as generate from './generate.js';
import * as testkit from './testkit.js';
import * as deploy from './deploy.js';
import * as native from './native.js';

export type {
  AdapterManifest,
  RunOptions,
  RunResult,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  InferenceOptions,
  OpenShellOptions,
  OpenShellPlan,
  NativeAgentInput,
  NativeAgentDefinition,
  NativeInstallResult,
  NativeVerificationReport,
} from './types.js';
export type {
  HarnessCase,
  HarnessSuite,
  CaseResult,
  SuiteReport,
  HarnessInvoke,
  SuiteOptions,
  MockInferenceReply,
  MockInferenceServer,
} from './testing-types.js';

import type {
  AdapterManifest,
  RunOptions,
  RunResult,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  InferenceOptions,
  OpenShellOptions,
  OpenShellPlan,
  NativeAgentInput,
  NativeAgentDefinition,
  NativeInstallResult,
  NativeVerificationReport,
} from './types.js';
import type {
  HarnessSuite,
  SuiteReport,
  SuiteOptions,
  MockInferenceReply,
  MockInferenceServer,
} from './testing-types.js';

export const VERSION: '0.3.0' = sdk.VERSION;
export const API_VERSION: 'harness-adapter.knowlet.dev/v1alpha1' = sdk.API_VERSION;
export const INFERENCE_URL: 'https://inference.local/v1' = sdk.INFERENCE_URL;
export const PLACEHOLDER_TOKEN: 'openshell' = sdk.PLACEHOLDER_TOKEN;
export const NOTICE: string = sdk.NOTICE;
export interface AdapterError extends Error {
  readonly code: string;
}
export const AdapterError: {
  new (code: string, message: string): AdapterError;
} = sdk.AdapterError as unknown as {
  new (code: string, message: string): AdapterError;
};

export const defineAdapter: (input: AdapterManifest) => Readonly<AdapterManifest> = sdk.defineAdapter;
export const createAdapter: (name?: string, model?: string) => Readonly<AdapterManifest> = sdk.createAdapter;
export const loadAdapter: (filename: string) => Promise<Readonly<AdapterManifest>> = sdk.loadAdapter;
export const assertManagedFile: (filename: string) => Promise<Readonly<AdapterManifest>> = sdk.assertManagedFile;
export const buildEnvironment: (
  adapter: AdapterManifest,
  parent?: Record<string, string | undefined>,
  home?: string,
) => Record<string, string> = sdk.buildEnvironment;
export const runHarness: (
  adapter: AdapterManifest,
  task: string,
  options?: RunOptions,
) => Promise<RunResult> = sdk.runHarness;
export const createInferenceClient: (options: InferenceOptions) => Readonly<{
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}> = sdk.createInferenceClient;
export const digest: (value: unknown) => string = sdk.digest;
export const assertImageDigest: (image: string) => string = sdk.assertImageDigest;
export const buildOpenShellCommand: (options: OpenShellOptions) => string[] = sdk.buildOpenShellCommand;

export const renderPolicy: (adapter: AdapterManifest) => string = generate.renderPolicy;
export const renderDockerfile: (adapter: AdapterManifest) => string = generate.renderDockerfile;
export const renderDeepSeekPatch: (adapter: AdapterManifest) => string = generate.renderDeepSeekPatch;
export const scaffold: (
  destination: string,
  options?: { name?: string; model?: string },
) => Promise<{ directory: string; adapter: Readonly<AdapterManifest> }> = generate.scaffold;

export const buildOpenShellPlan: (options: OpenShellOptions) => OpenShellPlan = deploy.buildOpenShellPlan;
export const launchOpenShell: (
  options: OpenShellOptions,
  controls?: { signal?: AbortSignal },
) => Promise<{ name: string; taskSucceeded: true }> = deploy.launchOpenShell;

export const SUITE_VERSION: 'harness-suite/v1' = testkit.SUITE_VERSION;
export const defineSuite: (input: HarnessSuite) => Readonly<HarnessSuite> = testkit.defineSuite;
export const runSuite: (input: HarnessSuite, options: SuiteOptions) => Promise<SuiteReport> = testkit.runSuite;
export const toJUnit: (report: SuiteReport) => string = testkit.toJUnit;
export const createMockInferenceServer: (options?: {
  model?: string;
  replies?: Array<string | MockInferenceReply>;
}) => Promise<MockInferenceServer> = testkit.createMockInferenceServer;

export const NATIVE_CONTRACT: Readonly<{
  upstream: string;
  revision: string;
  agentRoot: string;
  manifest: string;
  policy: string;
  dockerfile: string;
  start: string;
  harness: string;
  launcher: string;
  metadata: string;
}> = native.NATIVE_CONTRACT;
export const NATIVE_PACK_VERSION: number = native.NATIVE_PACK_VERSION;
export const NATIVE_REQUIRED_FILES: readonly string[] = native.NATIVE_REQUIRED_FILES;
export const defineNativeAgent: (input?: Partial<NativeAgentInput>) => NativeAgentDefinition = native.defineNativeAgent;
export const renderNativeManifest: (input?: Partial<NativeAgentInput>) => string = native.renderNativeManifest;
export const renderNativePolicy: (input?: Partial<NativeAgentInput>) => string = native.renderNativePolicy;
export const renderNativeDockerfile: (input?: Partial<NativeAgentInput>) => string = native.renderNativeDockerfile;
export const renderNativeLauncher: (input?: Partial<NativeAgentInput>) => string = native.renderNativeLauncher;
export const renderNativeStart: (input?: Partial<NativeAgentInput>) => string = native.renderNativeStart;
export const renderNativeHarness: (input?: Partial<NativeAgentInput>) => string = native.renderNativeHarness;
export const renderNativeDependencyReview: (input?: Partial<NativeAgentInput>) => string = native.renderNativeDependencyReview;
export const renderNativeMetadata: (input?: Partial<NativeAgentInput>) => string = native.renderNativeMetadata;
export const renderNativePackage: (input?: Partial<NativeAgentInput>) => Readonly<Record<string, string>> = native.renderNativePackage;
export const nativeAgentDir: (nemoclawRoot: string, name: string) => string = native.nativeAgentDir;
export const assertNativeCheckout: (nemoclawRoot: string) => Promise<string> = native.assertNativeCheckout;
export const scaffoldNativeAgent: (
  destination: string,
  input?: Partial<NativeAgentInput>,
) => Promise<{ directory: string; files: string[]; agent: NativeAgentDefinition }> = native.scaffoldNativeAgent;
export const readNativePackage: (directory: string) => Promise<{
  directory: string;
  agent: Record<string, unknown>;
  metadata: Record<string, unknown>;
}> = native.readNativePackage;
export const installNativeAgent: (
  directory: string,
  options: { nemoclawRoot: string; replace?: boolean },
) => Promise<NativeInstallResult> = native.installNativeAgent;
export const nativeVerifySource: () => string = native.nativeVerifySource;
export const verifyNativeAgent: (options: {
  nemoclawRoot: string;
  name: string;
  timeoutMs?: number;
}) => Promise<NativeVerificationReport> = native.verifyNativeAgent;

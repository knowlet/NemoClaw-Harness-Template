/** UNOFFICIAL community contract. Not an NVIDIA SDK or stable upstream manifest. */
export declare const VERSION: '0.2.0';
export declare const API_VERSION: 'harness-adapter.knowlet.dev/v1alpha1';
export declare const INFERENCE_URL: 'https://inference.local/v1';
export declare const PLACEHOLDER_TOKEN: 'openshell';
export declare const NOTICE: string;
export declare class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export interface AdapterManifest {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: 'HarnessAdapter';
  readonly metadata: { readonly name: string; readonly displayName: string; readonly unofficial: true };
  readonly runtime: {
    readonly command: readonly string[];
    readonly taskInput: 'stdin' | 'argv';
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly inference: { readonly baseUrl: typeof INFERENCE_URL; readonly model: string };
  readonly state: {
    readonly home: string; readonly workspace: string;
    readonly persist: readonly string[];
    readonly reconstruct: readonly string[];
    readonly prohibit: readonly string[];
  };
  readonly env?: Readonly<Record<string, string>>;
}
export interface RunOptions {
  cwd?: string;
  home?: string;
  parentEnv?: Record<string, string | undefined>;
  signal?: AbortSignal;
}
export interface RunResult { stdout: string; stderr: string; exitCode: 0; durationMs: number }
export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}
export interface ChatOptions {
  signal?: AbortSignal;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  seed?: number;
  top_p?: number;
}
export interface ChatResponse {
  choices: Array<{ message: ChatMessage; finish_reason?: string | null; index?: number }>;
  usage?: Record<string, number>;
  [key: string]: unknown;
}
export interface InferenceOptions {
  model: string;
  baseUrl?: string;
  development?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export interface OpenShellOptions {
  name: string;
  image: string;
  policy: string;
  task: string;
  allowMutableImage?: boolean;
}
export declare function defineAdapter(input: AdapterManifest): Readonly<AdapterManifest>;
export declare function createAdapter(name?: string, model?: string): Readonly<AdapterManifest>;
export declare function loadAdapter(filename: string): Promise<Readonly<AdapterManifest>>;
export declare function assertManagedFile(filename: string): Promise<Readonly<AdapterManifest>>;
export declare function buildEnvironment(adapter: AdapterManifest, parent?: Record<string, string | undefined>, home?: string): Record<string, string>;
/** Executes a trusted process; DOES NOT create a sandbox. */
export declare function runHarness(adapter: AdapterManifest, task: string, options?: RunOptions): Promise<RunResult>;
export declare function createInferenceClient(options: InferenceOptions): Readonly<{ chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> }>;
export declare function digest(value: unknown): string;
export declare function assertImageDigest(image: string): string;
export declare function buildOpenShellCommand(options: OpenShellOptions): string[];
export declare function renderPolicy(adapter: AdapterManifest): string;
export declare function renderDockerfile(adapter: AdapterManifest): string;
/** Experimental DeepSeek patch; inspect against the exact upstream source before deployment. */
export declare function renderDeepSeekPatch(adapter: AdapterManifest): string;
export declare function scaffold(destination: string, options?: { name?: string; model?: string }): Promise<{ directory: string; adapter: Readonly<AdapterManifest> }>;
export * from './testing.js';

export interface OpenShellPlan { create: string[]; ready: string[]; execute: string[] }
export declare function buildOpenShellPlan(options: OpenShellOptions): OpenShellPlan;
export declare function launchOpenShell(options: OpenShellOptions, controls?: { signal?: AbortSignal }): Promise<{ name: string; taskSucceeded: true }>;

export interface NativeAgentInput {
  name: string;
  displayName?: string;
  description?: string;
  model?: string;
  harness?: 'echo' | 'external';
}
export interface NativeAgentDefinition {
  readonly name: string;
  readonly harness: 'echo' | 'external';
  readonly displayName: string;
  readonly description: string;
  readonly model: string;
  readonly home: string;
  readonly stateDir: string;
  readonly installDir: string;
  readonly harnessPath: string;
}
export declare const NATIVE_CONTRACT: Readonly<{ upstream: string; revision: string; agentRoot: string; manifest: string; policy: string; dockerfile: string; start: string; harness: string; launcher: string; metadata: string }>;
export declare const NATIVE_PACK_VERSION: number;
export declare const NATIVE_REQUIRED_FILES: readonly string[];
export declare function defineNativeAgent(input?: Partial<NativeAgentInput>): NativeAgentDefinition;
export declare function renderNativeManifest(input?: Partial<NativeAgentInput>): string;
export declare function renderNativePolicy(input?: Partial<NativeAgentInput>): string;
export declare function renderNativeDockerfile(input?: Partial<NativeAgentInput>): string;
export declare function renderNativeStart(input?: Partial<NativeAgentInput>): string;
export declare function renderNativeHarness(input?: Partial<NativeAgentInput>): string;
export declare function renderNativeDependencyReview(input?: Partial<NativeAgentInput>): string;
export declare function renderNativeMetadata(input?: Partial<NativeAgentInput>): string;
export declare function renderNativePackage(input?: Partial<NativeAgentInput>): Readonly<Record<string, string>>;
export declare function nativeAgentDir(nemoclawRoot: string, name: string): string;
export declare function assertNativeCheckout(nemoclawRoot: string): Promise<string>;
export declare function scaffoldNativeAgent(destination: string, input?: Partial<NativeAgentInput>): Promise<{ directory: string; files: string[]; agent: NativeAgentDefinition }>;
export declare function readNativePackage(directory: string): Promise<{ directory: string; agent: Record<string, unknown>; metadata: Record<string, unknown> }>;
export declare function installNativeAgent(directory: string, options: { nemoclawRoot: string; replace?: boolean }): Promise<{ agentDir: string; name: string; upstream: string; revision: string }>;
export declare function nativeVerifySource(): string;
export declare function verifyNativeAgent(options: { nemoclawRoot: string; name: string; timeoutMs?: number }): Promise<Record<string, unknown>>;

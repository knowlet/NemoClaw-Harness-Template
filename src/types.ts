export interface AdapterError extends Error {
  readonly code: string;
}

export interface AdapterManifest {
  readonly apiVersion: 'harness-adapter.knowlet.dev/v1alpha1';
  readonly kind: 'HarnessAdapter';
  readonly metadata: { readonly name: string; readonly displayName: string; readonly unofficial: true };
  readonly runtime: {
    readonly command: readonly string[];
    readonly taskInput: 'stdin' | 'argv';
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly inference: { readonly baseUrl: 'https://inference.local/v1'; readonly model: string };
  readonly state: {
    readonly home: string;
    readonly workspace: string;
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

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: 0;
  durationMs: number;
}

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

export interface OpenShellPlan {
  create: string[];
  ready: string[];
  execute: string[];
}

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
  readonly binaryPath: string;
}

export interface NativeInstallResult {
  agentDir: string;
  name: string;
  upstream: string;
  revision: string;
}

export interface NativeVerificationReport extends Record<string, unknown> {
  unofficial: true;
  root: string;
  name: string;
  loaderAccepted: boolean;
  deploymentVerified: false;
  listed?: boolean;
  dockerfile?: string;
  policyAdditions?: string;
  error?: string;
}

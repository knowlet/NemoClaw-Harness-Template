import type { AdapterManifest, RunOptions } from './types.js';

export interface HarnessCase {
  readonly name: string;
  readonly task: string;
  readonly timeoutMs?: number;
  readonly expect:
    | { readonly stdout: string }
    | { readonly includes: string }
    | { readonly errorCode: string };
}

export interface HarnessSuite {
  readonly version: 'harness-suite/v1';
  readonly name: string;
  readonly cases: readonly HarnessCase[];
}

export interface CaseResult {
  name: string;
  status: 'passed' | 'failed' | 'cancelled';
  durationMs: number;
  failure?: string;
  errorCode?: string;
  stdoutSha256?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface SuiteReport {
  version: 'harness-suite/v1';
  name: string;
  unofficial: true;
  suiteSha256: string;
  execution: 'process' | 'custom-invoke';
  sandboxVerified: false;
  passed: number;
  failed: number;
  cancelled: number;
  ok: boolean;
  durationMs: number;
  cases: CaseResult[];
}

export type HarnessInvoke = (
  task: string,
  context: { signal: AbortSignal; caseName: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type SuiteOptions = RunOptions & (
  | { adapter: AdapterManifest; invoke?: never }
  | { adapter?: never; invoke: HarnessInvoke }
);

export interface MockInferenceReply {
  content: string | null;
  tool_calls?: unknown[];
}

export interface MockInferenceServer {
  baseUrl: string;
  readonly requests: Array<{
    model: string;
    messageCount: number;
    toolCount: number;
    placeholderAuth: boolean;
  }>;
  close(): Promise<void>;
}

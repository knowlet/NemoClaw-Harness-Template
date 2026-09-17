/** UNOFFICIAL testing API. Process contracts and mock fixtures are not sandbox attestation. */
import type { AdapterManifest, RunOptions } from './index.js';
export declare const SUITE_VERSION: 'harness-suite/v1';
export interface HarnessCase {
  readonly name: string;
  readonly task: string;
  readonly timeoutMs?: number;
  readonly expect: { readonly stdout: string } | { readonly includes: string } | { readonly errorCode: string };
}
export interface HarnessSuite { readonly version: typeof SUITE_VERSION; readonly name: string; readonly cases: readonly HarnessCase[] }
export interface CaseResult {
  name: string; status: 'passed' | 'failed' | 'cancelled'; durationMs: number;
  failure?: string; errorCode?: string; stdoutSha256?: string; stdoutBytes?: number; stderrBytes?: number;
}
export interface SuiteReport {
  version: typeof SUITE_VERSION; name: string; unofficial: true; suiteSha256: string;
  execution: 'process' | 'custom-invoke'; sandboxVerified: false;
  passed: number; failed: number; cancelled: number; ok: boolean; durationMs: number; cases: CaseResult[];
}
export type HarnessInvoke = (task: string, context: { signal: AbortSignal; caseName: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
export type SuiteOptions = RunOptions & ({ adapter: AdapterManifest; invoke?: never } | { adapter?: never; invoke: HarnessInvoke });
export declare function defineSuite(input: HarnessSuite): Readonly<HarnessSuite>;
export declare function runSuite(input: HarnessSuite, options: SuiteOptions): Promise<SuiteReport>;
export declare function toJUnit(report: SuiteReport): string;
export declare function createMockInferenceServer(options?: { model?: string; replies?: Array<string | { content: string | null; tool_calls?: unknown[] }> }): Promise<{
  baseUrl: string;
  readonly requests: Array<{ model: string; messageCount: number; toolCount: number; placeholderAuth: boolean }>;
  close(): Promise<void>;
}>;

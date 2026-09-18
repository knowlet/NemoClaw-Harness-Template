import * as testkit from './testkit.js';
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
  HarnessSuite,
  SuiteReport,
  SuiteOptions,
  MockInferenceReply,
  MockInferenceServer,
} from './testing-types.js';

export const SUITE_VERSION: 'harness-suite/v1' = testkit.SUITE_VERSION;
export const defineSuite: (input: HarnessSuite) => Readonly<HarnessSuite> = testkit.defineSuite;
export const runSuite: (input: HarnessSuite, options: SuiteOptions) => Promise<SuiteReport> = testkit.runSuite as unknown as (input: HarnessSuite, options: SuiteOptions) => Promise<SuiteReport>;
export const toJUnit: (report: SuiteReport) => string = testkit.toJUnit;
export const createMockInferenceServer: (options?: {
  model?: string;
  replies?: Array<string | MockInferenceReply>;
}) => Promise<MockInferenceServer> = testkit.createMockInferenceServer as unknown as (options?: { model?: string; replies?: Array<string | MockInferenceReply> }) => Promise<MockInferenceServer>;

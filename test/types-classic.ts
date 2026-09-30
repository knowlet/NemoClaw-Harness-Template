// Classic node resolution follows the package's top-level types field.
// Package subpath exports are exercised separately by the NodeNext fixture.
import {
  AdapterError,
  createAdapter,
  defineNativeAgent,
  installNativeAgent,
  runSuite,
  SUITE_VERSION,
  type NativeInstallResult,
  type SuiteReport,
} from '@knowlet/nemoclaw-harness-sdk';

const adapter = createAdapter('classic-consumer');
const agent = defineNativeAgent({ name: 'classic-native' });
const installed: Promise<NativeInstallResult> = installNativeAgent('/tmp/package', { nemoclawRoot: '/tmp/NemoClaw' });
const report: Promise<SuiteReport> = runSuite({ version: SUITE_VERSION, name: agent.name, cases: [] }, { adapter });
const error: AdapterError = new AdapterError('TEST', 'test');
void installed; void report; void error.code;

// @ts-expect-error native installation requires the target checkout
void installNativeAgent('/tmp/package', {});
// @ts-expect-error a suite requires exactly one execution backend
void runSuite({ version: SUITE_VERSION, name: 'missing-backend', cases: [] }, {});
// @ts-expect-error manifests stay readonly in emitted declarations
adapter.runtime.command.push('unexpected');

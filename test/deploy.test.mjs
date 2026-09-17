import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenShellPlan, launchOpenShell } from '../src/index.mjs';
const options = { name: 'test-agent', image: 'test:dev', policy: 'policy.yaml', task: 'literal $(command); "quote"', allowMutableImage: true };
test('headless deployment keeps sandbox lifetime separate from task execution', () => {
  const plan = buildOpenShellPlan(options);
  assert.deepEqual(plan.create.slice(-3), ['--', '/usr/bin/sleep', 'infinity']);
  assert.ok(plan.create.includes('--detach'));
  assert.ok(plan.create.includes('--no-auto-providers'));
  assert.ok(!plan.create.includes(options.task));
  assert.deepEqual(plan.ready.slice(-2), ['--', '/usr/bin/true']);
  assert.equal(plan.execute.at(-1), options.task);
  assert.ok(plan.execute.includes('--managed'));
});
test('deployment plan retains immutable-image validation', () => {
  assert.throws(() => buildOpenShellPlan({ ...options, allowMutableImage: false }), { code: 'UNPINNED_IMAGE' });
});
test('pre-cancelled deployment never starts a CLI', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(launchOpenShell(options, { signal: controller.signal }), { code: 'ABORTED' });
});

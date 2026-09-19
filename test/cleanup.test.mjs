/** UNOFFICIAL tests for quickstart sandbox cleanup classification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDestroyResult, confirmsSandboxAbsent } from '../scripts/lib/sandbox-cleanup.mjs';

const sandbox = 'my-sandbox';

test('a plain failure stays a failure with a useful detail', () => {
  const verdict = classifyDestroyResult({ code: 42, stderr: 'Permission denied deleting sandbox my-sandbox', sandbox });
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /Permission denied/);
});

test('a zero exit is success', () => {
  assert.deepEqual(classifyDestroyResult({ code: 0, stdout: "destroyed my-sandbox", sandbox }).ok, true);
});

test('output that only mentions something missing is not a deleted sandbox', () => {
  // "not found" is deliberately never enough on its own: each of these describes
  // something other than a confirmed absence of the sandbox.
  const cases = [
    'OpenShell gateway not found; cannot delete sandbox my-sandbox',
    'Warning: bridge provider not found' + String.fromCharCode(10) + 'Error: Permission denied deleting sandbox my-sandbox',
    'helper not found at /usr/local/bin/openshell',
    'config file not found',
    'Sandbox does not exist: my-sandbox',
    'no such sandbox: my-sandbox',
    'sandbox my-sandbox not found',
    'Error: sandbox my-sandbox not found while deleting: permission denied',
    'sandbox my-sandbox not found in the provider registry; destroy failed',
    'Sandbox my-sandbox is not present in the provider registry; destroy failed',
    'Sandbox my-sandbox is absent from the running list; destroy failed',
    'Error: sandbox my-sandbox does not exist in the registry',
  ];
  for (const text of cases) {
    const verdict = classifyDestroyResult({ code: 42, stderr: text, sandbox });
    assert.equal(verdict.ok, false, text);
    assert.equal(verdict.absent, false, text);
    assert.ok(verdict.detail, 'a failing verdict must carry a detail');
  }
});

test('an absence message about another sandbox does not count', () => {
  const verdict = classifyDestroyResult({ code: 1, stdout: "Sandbox 'other-sandbox' does not exist.", sandbox });
  assert.equal(verdict.ok, false);
});

test('absence phrasings about this sandbox count as clean', () => {
  const messages = [
    "Sandbox 'my-sandbox' does not exist. Run 'nemoclaw onboard' to create one.",
    'Sandbox my-sandbox does not exist',
    'Sandbox "my-sandbox" does not exist',
    "Sandbox 'my-sandbox' was already absent from the live gateway.",
    "Sandbox 'my-sandbox' is absent",
    'Sandbox my-sandbox is not present',
    'Sandbox my-sandbox is no longer present',
  ];
  for (const message of messages) {
    const verdict = classifyDestroyResult({ code: 1, stdout: message, sandbox });
    assert.equal(verdict.ok, true, message);
    assert.equal(verdict.absent, true, message);
  }
});

test('absence is never inferred from an empty or unrelated report', () => {
  assert.equal(confirmsSandboxAbsent('', sandbox), false);
  assert.equal(confirmsSandboxAbsent('sandbox does not exist', sandbox), false);
  assert.equal(classifyDestroyResult({ code: 1, sandbox }).ok, false);
});

/** UNOFFICIAL tests for quickstart sandbox cleanup classification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDestroyResult,
  classifySandboxPreflightResult,
  confirmsSandboxPreflightAbsent,
  confirmsSandboxAbsent,
} from '../scripts/lib/sandbox-cleanup.mjs';

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

test('preflight claims ownership only for an explicit absence of the requested sandbox', () => {
  const absent = classifySandboxPreflightResult({
    code: 1,
    stderr: "Error: sandbox 'my-sandbox' not found",
    sandbox,
  });
  assert.deepEqual(
    { ok: absent.ok, owned: absent.owned, preexisting: absent.preexisting, errorCode: absent.errorCode },
    { ok: true, owned: true, preexisting: false, errorCode: null },
  );

  const existing = classifySandboxPreflightResult({ code: 0, stdout: 'Sandbox my-sandbox is running', sandbox });
  assert.equal(existing.ok, false);
  assert.equal(existing.owned, false);
  assert.equal(existing.preexisting, true);
  assert.equal(existing.errorCode, 'SANDBOX_EXISTS');

  const ambiguous = classifySandboxPreflightResult({ code: 1, stderr: 'gateway not found', sandbox });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.owned, false);
  assert.equal(ambiguous.errorCode, 'SANDBOX_PREFLIGHT_FAILED');
});

test('preflight accepts explicit not-found output and rejects attached failures', () => {
  assert.equal(confirmsSandboxPreflightAbsent("Error: sandbox 'my-sandbox' not found", sandbox), true);
  assert.equal(confirmsSandboxPreflightAbsent('Sandbox my-sandbox does not exist', sandbox), true);
  assert.equal(confirmsSandboxPreflightAbsent('gateway not found', sandbox), false);
  assert.equal(confirmsSandboxPreflightAbsent('sandbox my-sandbox not found while deleting: permission denied', sandbox), false);
  assert.equal(confirmsSandboxPreflightAbsent('sandbox my-sandbox not found; error contacting gateway', sandbox), false);
  assert.equal(confirmsSandboxPreflightAbsent('sandbox my-sandbox not found\ngateway unavailable', sandbox), false);
});

// Captured from the pinned OpenShell v0.0.116 CLI: a direct lookup for a
// missing sandbox answers with a structured status that never repeats the
// sandbox name, so the name-scoped prose patterns above cannot match it.
test('preflight accepts the pinned structured not-found response', () => {
  const structured = (message) =>
    "Error:   \u00d7 code: 'Some requested entity was not found', message: \"" + message + "\"";
  assert.equal(confirmsSandboxPreflightAbsent(structured('sandbox not found'), sandbox), true);
  assert.equal(confirmsSandboxPreflightAbsent(structured('sandbox my-sandbox not found'), sandbox), true);
  assert.equal(confirmsSandboxPreflightAbsent("\u001b[31mError:\u001b[0m " + structured('sandbox not found').slice(6), sandbox), true);
  assert.equal(confirmsSandboxPreflightAbsent(structured('sandbox other-sandbox not found'), sandbox), false);
  assert.equal(confirmsSandboxPreflightAbsent(structured('gateway my-gateway not found'), sandbox), false);
  assert.equal(confirmsSandboxPreflightAbsent(structured('provider openai not found'), sandbox), false);
  assert.equal(confirmsSandboxPreflightAbsent(structured('sandbox not found') + '\ngateway unavailable', sandbox), false);

  assert.equal(confirmsSandboxAbsent(structured('sandbox not found'), sandbox), true);
  assert.equal(confirmsSandboxAbsent(structured('sandbox my-sandbox not found'), sandbox), true);
  assert.equal(confirmsSandboxAbsent(structured('sandbox other-sandbox not found'), sandbox), false);
  assert.equal(confirmsSandboxAbsent(structured('gateway my-gateway not found'), sandbox), false);
  assert.equal(confirmsSandboxAbsent(structured('provider openai not found'), sandbox), false);
  assert.equal(confirmsSandboxAbsent('connection refused while deleting sandbox my-sandbox', sandbox), false);

  const destroyed = classifyDestroyResult({ code: 1, stderr: structured('sandbox not found'), sandbox });
  assert.equal(destroyed.ok, true);
  assert.equal(destroyed.absent, true);

  const verdict = classifySandboxPreflightResult({
    code: 1,
    stderr: structured('sandbox not found'),
    sandbox,
  });
  assert.deepEqual(
    { ok: verdict.ok, owned: verdict.owned, preexisting: verdict.preexisting, errorCode: verdict.errorCode },
    { ok: true, owned: true, preexisting: false, errorCode: null },
  );
});

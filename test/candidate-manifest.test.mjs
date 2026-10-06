/** UNOFFICIAL regressions for explicitly qualified complete-home candidates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_CONTRACT, scaffoldNativeAgent, readNativePackage, renderNativeManifest } from '../src/index.mjs';
import {
  COMPLETE_HOME_CONTRACT, prepareCandidateManifest, loaderStage,
  persistenceProbeSource, qualifyCandidatePersistence,
} from '../scripts/lib/candidate-manifest.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-candidate-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = path.join(root, 'agent');
  await scaffoldNativeAgent(pack, { name: 'compat-echo' });
  return pack;
}
const options = { stateContract: COMPLETE_HOME_CONTRACT, revision: 'd'.repeat(40), nativeContract: NATIVE_CONTRACT };

test('candidate migration is explicit, records provenance, and never changes the pinned generator', async t => {
  const pack = await fixture(t);
  const original = await readFile(path.join(pack, 'manifest.yaml'), 'utf8');
  const receipt = await prepareCandidateManifest(pack, options);
  const migrated = await readFile(path.join(pack, 'manifest.yaml'), 'utf8');
  assert.equal(migrated, original.replace('state_dirs:\n  - path: sessions\n', ''));
  assert.doesNotMatch(migrated, /^(state_dirs|state_files|runtime_auth_state_dirs):/m);
  assert.equal(renderNativeManifest({ name: 'compat-echo' }), original);
  assert.equal(receipt.qualificationOnly, true);
  assert.equal(receipt.persistenceVerified, false);
  assert.equal(receipt.targetRevision, options.revision);
  assert.equal(receipt.templateRevision, NATIVE_CONTRACT.revision);
  assert.match(receipt.originalManifestSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(receipt.originalManifestSha256, receipt.manifestSha256);
  const parsed = await readNativePackage(pack);
  assert.deepEqual(parsed.metadata.qualification, receipt);
  assert.equal(parsed.metadata.contract.revision, NATIVE_CONTRACT.revision);
  await assert.rejects(prepareCandidateManifest(pack, options), { code: 'CANDIDATE_CONTRACT_INVALID' });
});

test('candidate migration refuses the supported pin, unknown profiles, and malformed revisions', async t => {
  const pack = await fixture(t);
  const original = await readFile(path.join(pack, 'manifest.yaml'), 'utf8');
  for (const changes of [{ revision: NATIVE_CONTRACT.revision }, { revision: 'main' }, { stateContract: 'auto' }]) {
    await assert.rejects(prepareCandidateManifest(pack, { ...options, ...changes }), { code: 'CANDIDATE_CONTRACT_INVALID' });
    assert.equal(await readFile(path.join(pack, 'manifest.yaml'), 'utf8'), original);
  }
});

test('candidate migration never rewrites customized or retired-field user manifests', async t => {
  for (const addition of ['# user change\n', 'state_files: []\n', 'runtime_auth_state_dirs: []\n']) {
    const pack = await fixture(t);
    const target = path.join(pack, 'manifest.yaml');
    const modified = await readFile(target, 'utf8') + addition;
    await writeFile(target, modified);
    await assert.rejects(prepareCandidateManifest(pack, options), { code: 'CANDIDATE_CONTRACT_INVALID' });
    assert.equal(await readFile(target, 'utf8'), modified);
  }
});

test('loader rejection keeps bounded, sanitized diagnostics rather than only false', () => {
  const key = 'NHA_TEST_CANDIDATE_API_KEY';
  const previous = process.env[key];
  process.env[key] = 'synthetic-candidate-credential-7943';
  try {
    const error = "Agent manifest field 'state_dirs' is retired " + process.env[key];
    const stage = loaderStage({ loaderAccepted: false, checkoutRevision: options.revision, error });
    assert.equal(stage.errorCode, 'LOADER_REJECTED');
    assert.match(stage.error, /state_dirs/);
    assert.match(stage.error, /\[REDACTED\]/);
    assert.equal(stage.error.includes(process.env[key]), false);
    assert.equal(stage.checkoutRevision, options.revision);
    assert.ok(Buffer.byteLength(loaderStage({ error: 'x'.repeat(10000) }).error) <= 4096);
    assert.equal(loaderStage({ loaderAccepted: 'true' }).status, 'failed');
    assert.equal(loaderStage({ loaderAccepted: true }).error, undefined);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('complete-home qualification requires seed, rebuild, restored files, and a post-rebuild task', async () => {
  const result = { checkout: '/fixture', sandbox: { name: 'owned' }, stages: {}, manifestQualification: { persistenceVerified: false } };
  const calls = [];
  assert.equal(await qualifyCandidatePersistence({ result, name: 'compat-echo', cli: '/fixture/nemoclaw.js', env: {}, execute: async (key, argv, opts) => {
    calls.push({ key, argv, opts });
    return { code: 0, markerSeen: true };
  } }), true);
  assert.deepEqual(calls.map(c => c.key), ['state-seed', 'rebuild', 'state-verify', 'post-rebuild-exec']);
  assert.deepEqual(calls[1].argv.slice(2), ['sandbox', 'rebuild', 'owned', '--yes']);
  assert.equal(calls.some(c => c.argv.includes('--force')), false);
  assert.match(calls[0].argv.at(-1), /flag: "wx"/);
  assert.match(calls[2].argv.at(-1), /fs.readFileSync/);
  assert.match(calls[2].argv.at(-1), /unlisted\/custom-state/);
  assert.equal(result.manifestQualification.persistenceVerified, true);
});

for (const failed of ['state-seed', 'rebuild', 'state-verify', 'post-rebuild-exec']) {
  test('complete-home qualification remains failed at ' + failed, async () => {
    const result = { checkout: '/fixture', sandbox: { name: 'owned' }, stages: {}, manifestQualification: { persistenceVerified: false } };
    const calls = [];
    assert.equal(await qualifyCandidatePersistence({ result, name: 'compat-echo', cli: '/fixture/nemoclaw.js', env: {}, execute: async key => {
      calls.push(key);
      return { code: key === failed ? 1 : 0, markerSeen: true };
    } }), false);
    assert.equal(calls.at(-1), failed);
    assert.equal(result.status, 'failed');
    assert.equal(result.manifestQualification.persistenceVerified, false);
  });
}

test('zero-exit state probe without the run-specific marker is not persistence proof', async () => {
  const result = { checkout: '/fixture', sandbox: { name: 'owned' }, stages: {}, manifestQualification: {} };
  assert.equal(await qualifyCandidatePersistence({ result, name: 'compat-echo', cli: '/fixture/nemoclaw.js', env: {}, execute: async key => ({ code: 0, markerSeen: key !== 'state-verify' }) }), false);
  assert.equal(result.stages['state-verify'].errorCode, 'STATE_SMOKE_MISMATCH');
  assert.equal(result.stages['post-rebuild-exec'], undefined);
});

test('persistence probes refuse injected agent names and non-run identifiers', () => {
  assert.throws(() => persistenceProbeSource('../outside', 'a'.repeat(36)), { code: 'CANDIDATE_CONTRACT_INVALID' });
  assert.throws(() => persistenceProbeSource('compat-echo', '";throw 1'), { code: 'CANDIDATE_CONTRACT_INVALID' });
});

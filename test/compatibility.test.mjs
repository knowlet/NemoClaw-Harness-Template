/** UNOFFICIAL tests for the NemoClaw compatibility qualification runner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function fakeCheckout(root) {
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/agent'), { recursive: true });
  await mkdir(path.join(root, 'dist/lib/onboard/workload'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'nemoclaw', version: 'candidate', type: 'commonjs' }) + '\n');
  await writeFile(path.join(root, 'dist/lib/agent/defs.js'), [
    "const path = require('node:path');",
    "exports.listAgents = () => ['compat-echo'];",
    "exports.loadAgent = (name) => ({ dockerfilePath: path.join(process.cwd(), 'agents', name, 'Dockerfile'), runtime: { kind: 'terminal' }, configPaths: { dir: path.join(process.cwd(), 'agents', name) } });",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'dist/lib/agent/onboard.js'), [
    "const path = require('node:path');",
    "exports.getAgentPolicyPath = (agent) => path.join(path.dirname(agent.dockerfilePath), 'policy-additions.yaml');",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'dist/lib/onboard/workload/source.js'), [
    "exports.resolveSandboxWorkloadSource = ({ legacyDockerfilePath }) => ({ kind: 'legacy-dockerfile', dockerfilePath: legacyDockerfilePath, reason: 'candidate-fixture' });",
    '',
  ].join('\n'));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'nha-tests@example.invalid'],
    ['config', 'user.name', 'NHA tests'],
    ['add', '.'],
    ['commit', '-qm', 'candidate fixture'],
  ]) execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function runCompatibility(args) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts/compatibility.mjs'), ...args], { encoding: 'utf8' });
}

test('compatibility runner qualifies a candidate loader and writes a report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    const revision = await fakeCheckout(checkout);
    const report = path.join(root, 'report.json');
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--expected', 'candidate=' + revision, '--json', report]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'passed');
    assert.equal(parsed.cases.length, 1);
    assert.equal(parsed.cases[0].actualRevision, revision);
    assert.equal(parsed.cases[0].supportedUpstream, false);
    assert.equal(parsed.cases[0].stages.loader.status, 'passed');
    assert.equal(parsed.cases[0].stages.onboard.status, 'skipped');
    assert.equal(JSON.parse(await readFile(report, 'utf8')).status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility runner classifies an unexpected checkout revision as contract failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nha-compat-test-'));
  try {
    const checkout = path.join(root, 'NemoClaw');
    const revision = await fakeCheckout(checkout);
    const result = runCompatibility(['--checkout', 'candidate=' + checkout, '--expected', 'candidate=' + '0'.repeat(40)]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.cases[0].failureClass, 'contract');
    assert.equal(parsed.cases[0].stages.checkout.errorCode, 'PIN_MISMATCH');
    assert.equal(parsed.cases[0].actualRevision, revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

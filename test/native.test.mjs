/** UNOFFICIAL tests for NemoClaw-native agent packaging. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_CONTRACT, NATIVE_PACK_VERSION, defineNativeAgent, renderNativeDockerfile, renderNativeHarness,
  renderNativeManifest, renderNativeMetadata, renderNativePackage, renderNativePolicy, renderNativeStart,
  nativeAgentDir, nativeVerifySource, scaffoldNativeAgent, readNativePackage, installNativeAgent,
  assertNativeCheckout, verifyNativeAgent,
} from '../src/index.mjs';

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'nha-native-test-')); }

async function fakeCheckout(root) {
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'nemoclaw', version: '0.1.0' }) + '\n');
  return root;
}

test('defineNativeAgent validates the agent name', () => {
  assert.equal(defineNativeAgent({ name: 'my-harness' }).name, 'my-harness');
  for (const name of ['My-Harness', 'my_harness', '1harness', '-harness', '', 'a'.repeat(33)]) {
    assert.throws(() => defineNativeAgent({ name }), /Agent name/);
  }
  assert.throws(() => defineNativeAgent(null), /must be an object/);
  assert.throws(() => defineNativeAgent({ name: 'ok', harness: 'other' }), /harness must be/);
});

test('generated files carry no unresolved template artifacts', () => {
  const files = renderNativePackage({ name: 'my-harness' });
  for (const [name, content] of Object.entries(files)) {
    assert.ok(content.length > 0, name + ' is empty');
    assert.ok(!content.includes('undefined'), name + ' contains an unresolved value');
    for (const marker of ['${agent', '${NATIVE', '${name', '${model']) assert.ok(!content.includes(marker), name + ' contains an unrendered interpolation');
    assert.ok(content.endsWith('\n'), name + ' must end with a newline');
    assert.ok(!/[ \t]+$/m.test(content), name + ' has trailing whitespace');
  }
  assert.deepEqual(Object.keys(files).sort(), ['Dockerfile', 'dependency-review.md', 'harness.mjs', 'launcher.sh', 'manifest.yaml', 'native-agent.json', 'policy-additions.yaml', 'start.sh']);
});

test('the starter harness keeps newline escapes inside its string literals', () => {
  const harness = renderNativeHarness({ name: 'my-harness' });
  // A real newline inside the literal would make the generated file invalid JavaScript.
  assert.ok(harness.includes('"Echo: " + task + "\\n"'));
  assert.ok(harness.includes('"NEMO_SMOKE_OK\\n"'));
  assert.equal(harness.split('\n').filter((line) => line.includes('process.stdout.write')).length, 2);
});

test('the loader probe keeps its JSON terminator escaped', () => {
  const probe = nativeVerifySource();
  assert.ok(probe.includes('JSON.stringify(result, null, 2) + "\\n"'));
  assert.ok(probe.includes('deploymentVerified: false'));
});

test('the manifest declares the fields the upstream loader reads', () => {
  const manifest = renderNativeManifest({ name: 'my-harness', model: 'fixture-model' });
  for (const fragment of ['name: my-harness', 'binary_path: /usr/local/bin/my-harness', 'runtime:', '  kind: terminal', 'headless_command:', 'state_dirs:', 'mcp:', '  support: disabled', 'inference:', 'default_model: "fixture-model"']) {
    assert.ok(manifest.includes(fragment), 'manifest is missing ' + fragment);
  }
  assert.ok(manifest.includes('agents/') === false);
});

test('the policy keeps the deny-by-default managed inference route', () => {
  const policy = renderNativePolicy({ name: 'my-harness' });
  assert.ok(policy.includes('version: 1'));
  assert.ok(policy.includes('network_policies:'));
  assert.ok(policy.includes('inference.local'));
  assert.ok(policy.includes('run_as_user: sandbox'));
  assert.ok(policy.includes('/sandbox/.my-harness'));
  assert.ok(policy.includes('/usr/local/lib/nemo-my-harness/**'));
});

test('the Dockerfile copies repository-relative agent paths and records the pinned contract', () => {
  const dockerfile = renderNativeDockerfile({ name: 'my-harness' });
  assert.ok(dockerfile.includes('FROM ${BASE_IMAGE}'));
  assert.ok(dockerfile.includes('ARG BASE_IMAGE=node:24-bookworm-slim'));
  assert.ok(dockerfile.includes('COPY agents/my-harness/harness.mjs /usr/local/lib/nemo-my-harness/harness.mjs'));
  assert.ok(dockerfile.includes('COPY agents/my-harness/start.sh /usr/local/bin/nemoclaw-start'));
  assert.ok(dockerfile.includes('COPY agents/my-harness/launcher.sh /usr/local/bin/my-harness'));
  assert.ok(dockerfile.includes('ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]'));
  // Real onboarding failed without this: the OpenShell supervisor needs iproute2 in the image.
  assert.ok(dockerfile.includes('ca-certificates iproute2 nftables'));
  assert.ok(renderNativeMetadata({ name: 'my-harness' }).includes(NATIVE_CONTRACT.revision));
});

test('the launcher execs the harness so the manifest binary_path is observable', () => {
  const files = renderNativePackage({ name: 'my-harness' });
  assert.ok(files['launcher.sh'].includes('exec /usr/local/bin/node /usr/local/lib/nemo-my-harness/harness.mjs "$@"'));
  assert.ok(renderNativeManifest({ name: 'my-harness' }).includes('binary_path: /usr/local/bin/my-harness'));
});

test('the entrypoint stays alive for exec calls', () => {
  assert.ok(renderNativeStart({ name: 'my-harness' }).includes('exec /usr/bin/sleep infinity'));
});

test('scaffoldNativeAgent writes an exclusive package', async () => {
  const root = await tempDir();
  try {
    const destination = path.join(root, 'my-harness');
    const result = await scaffoldNativeAgent(destination, { name: 'my-harness' });
    assert.equal(result.agent.name, 'my-harness');
    assert.equal(result.directory, destination);
    await assert.rejects(() => scaffoldNativeAgent(destination, { name: 'my-harness' }), /Refusing to overwrite/);
    const metadata = JSON.parse(await readFile(path.join(destination, NATIVE_CONTRACT.metadata), 'utf8'));
    assert.equal(metadata.pack, 'nemoclaw-native-agent');
    assert.equal(metadata.packVersion, NATIVE_PACK_VERSION);
    assert.equal(metadata.unofficial, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installNativeAgent registers the package in a checkout', async () => {
  const root = await tempDir();
  try {
    const checkout = await fakeCheckout(path.join(root, 'NemoClaw'));
    const pack = path.join(root, 'my-harness');
    await scaffoldNativeAgent(pack, { name: 'my-harness' });
    const installed = await installNativeAgent(pack, { nemoclawRoot: checkout });
    assert.equal(installed.agentDir, path.join(checkout, 'agents', 'my-harness'));
    assert.equal(await readFile(path.join(installed.agentDir, NATIVE_CONTRACT.manifest), 'utf8').then((text) => text.includes('name: my-harness')), true);
    await assert.rejects(() => installNativeAgent(pack, { nemoclawRoot: checkout }), /already installed/);
    const replaced = await installNativeAgent(pack, { nemoclawRoot: checkout, replace: true });
    assert.equal(replaced.name, 'my-harness');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkout and package validation fail closed', async () => {
  const root = await tempDir();
  try {
    await assert.rejects(() => assertNativeCheckout(path.join(root, 'missing')), (error) => error.code === 'NOT_A_CHECKOUT');
    await mkdir(path.join(root, 'not-a-checkout'));
    await writeFile(path.join(root, 'not-a-checkout', 'package.json'), JSON.stringify({ name: 'something-else' }));
    await assert.rejects(() => assertNativeCheckout(path.join(root, 'not-a-checkout')), (error) => error.code === 'NOT_A_CHECKOUT');
    await mkdir(path.join(root, 'empty'));
    await assert.rejects(() => readNativePackage(path.join(root, 'empty')), (error) => error.code === 'INVALID_PACKAGE');
    await assert.rejects(() => installNativeAgent(path.join(root, 'empty'), { nemoclawRoot: root }), (error) => error.code === 'INVALID_PACKAGE');
    await assert.rejects(() => installNativeAgent(path.join(root, 'empty'), {}), /checkout is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verifyNativeAgent refuses an unbuilt or invalid request', async () => {
  const root = await tempDir();
  try {
    const checkout = await fakeCheckout(path.join(root, 'NemoClaw'));
    await assert.rejects(() => verifyNativeAgent({ nemoclawRoot: checkout, name: 'my-harness' }), (error) => error.code === 'NOT_BUILT');
    await assert.rejects(() => verifyNativeAgent({ nemoclawRoot: checkout, name: 'Bad_Name' }), (error) => error.code === 'USAGE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nativeAgentDir stays inside the checkout agents directory', () => {
  assert.equal(nativeAgentDir('/tmp/NemoClaw', 'my-harness'), path.join('/tmp/NemoClaw', 'agents', 'my-harness'));
});

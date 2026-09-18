/** UNOFFICIAL tests for NemoClaw-native agent packaging. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_CONTRACT, NATIVE_PACK_VERSION, defineNativeAgent, renderNativeDockerfile, renderNativeHarness,
  renderNativeManifest, renderNativeMetadata, renderNativePackage, renderNativePolicy, renderNativeStart,
  nativeAgentDir, nativeVerifySource, NATIVE_REQUIRED_FILES, scaffoldNativeAgent, readNativePackage, installNativeAgent,
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
    // 'undefined' is valid JavaScript in the generated payload scripts; in a data or shell file it means a renderer bug.
    if (!name.endsWith('.mjs')) assert.ok(!content.includes('undefined'), name + ' contains an unresolved value');
    for (const marker of ['${agent', '${NATIVE', '${name', '${model']) assert.ok(!content.includes(marker), name + ' contains an unrendered interpolation');
    assert.ok(content.endsWith('\n'), name + ' must end with a newline');
    assert.ok(!/[ \t]+$/m.test(content), name + ' has trailing whitespace');
  }
  assert.deepEqual(Object.keys(files).sort(), ['Dockerfile', 'dependency-review.md', 'harness.mjs', 'harness.test.mjs', 'launcher.sh', 'manifest.yaml', 'native-agent.json', 'policy-additions.yaml', 'start.sh']);
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


test('reserved names are refused wherever they can enter', async () => {
  const reserved = ['node', 'nemoclaw-start', 'openclaw', 'hermes', 'pi', 'nemocua', 'langchain-deepagents-code'];
  for (const name of reserved) assert.throws(() => defineNativeAgent({ name }), /reserved/);
  const root = await tempDir();
  try {
    const checkout = await fakeCheckout(path.join(root, 'NemoClaw'));
    const pack = path.join(root, 'renamed');
    await scaffoldNativeAgent(pack, { name: 'safe-name' });
    const metadata = JSON.parse(await readFile(path.join(pack, NATIVE_CONTRACT.metadata), 'utf8'));
    metadata.agent.name = 'openclaw';
    await writeFile(path.join(pack, NATIVE_CONTRACT.metadata), JSON.stringify(metadata));
    await assert.rejects(() => readNativePackage(pack), (error) => error.code === 'INVALID_PACKAGE');
    await assert.rejects(() => installNativeAgent(pack, { nemoclawRoot: checkout }), (error) => error.code === 'INVALID_PACKAGE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every required file is validated, including the launcher', async () => {
  const root = await tempDir();
  try {
    for (const required of NATIVE_REQUIRED_FILES) {
      const pack = path.join(root, 'missing-' + String(NATIVE_REQUIRED_FILES.indexOf(required)));
      await scaffoldNativeAgent(pack, { name: 'pkg' });
      await rm(path.join(pack, required));
      await assert.rejects(() => readNativePackage(pack), (error) => error.code === 'INVALID_PACKAGE', required);
    }
    const pack = path.join(root, 'launcher-directory');
    await scaffoldNativeAgent(pack, { name: 'pkg' });
    await rm(path.join(pack, NATIVE_CONTRACT.launcher));
    await mkdir(path.join(pack, NATIVE_CONTRACT.launcher));
    await assert.rejects(() => readNativePackage(pack), (error) => error.code === 'INVALID_PACKAGE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('install refuses a same-path package and keeps the installed one', async () => {
  const root = await tempDir();
  try {
    const checkout = await fakeCheckout(path.join(root, 'NemoClaw'));
    const pack = path.join(root, 'my-harness');
    await scaffoldNativeAgent(pack, { name: 'my-harness' });
    const installed = await installNativeAgent(pack, { nemoclawRoot: checkout });
    await writeFile(path.join(installed.agentDir, 'KEEP.txt'), 'keep' + String.fromCharCode(10));
    await assert.rejects(() => installNativeAgent(installed.agentDir, { nemoclawRoot: checkout, replace: true }), (error) => error.code === 'SAME_PATH');
    assert.ok((await readdir(installed.agentDir)).includes('KEEP.txt'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('install never replaces an agent directory this SDK did not write', async () => {
  const root = await tempDir();
  try {
    const checkout = await fakeCheckout(path.join(root, 'NemoClaw'));
    const foreign = path.join(checkout, 'agents', 'handwritten');
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, NATIVE_CONTRACT.manifest), 'name: handwritten' + String.fromCharCode(10) + '# UNTOUCHED' + String.fromCharCode(10));
    const pack = path.join(root, 'handwritten');
    await scaffoldNativeAgent(pack, { name: 'handwritten' });
    await assert.rejects(() => installNativeAgent(pack, { nemoclawRoot: checkout, replace: true }), (error) => error.code === 'NOT_SDK_PACKAGE');
    assert.ok((await readFile(path.join(foreign, NATIVE_CONTRACT.manifest), 'utf8')).includes('UNTOUCHED'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('install stages the replacement and leaves no staging directory behind', async () => {
  const root = await tempDir();
  try {
    const checkout = await fakeCheckout(path.join(root, 'NemoClaw'));
    const pack = path.join(root, 'my-harness');
    await scaffoldNativeAgent(pack, { name: 'my-harness' });
    await installNativeAgent(pack, { nemoclawRoot: checkout });
    const replaced = await installNativeAgent(pack, { nemoclawRoot: checkout, replace: true });
    assert.ok((await readdir(replaced.agentDir)).includes(NATIVE_CONTRACT.launcher));
    assert.deepEqual((await readdir(path.join(checkout, 'agents'))).sort(), ['my-harness']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verify reports a timeout instead of a generic failure', async () => {
  const root = await tempDir();
  try {
    const checkout = await fakeCheckout(path.join(root, 'NemoClaw'));
    const hang = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);';
    for (const file of ['dist/lib/agent/defs.js', 'dist/lib/agent/onboard.js', 'dist/lib/onboard/workload/source.js']) {
      const entry = path.join(checkout, file);
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, file.endsWith('defs.js') ? hang : 'module.exports = {};');
    }
    await assert.rejects(
      () => verifyNativeAgent({ nemoclawRoot: checkout, name: 'my-harness', timeoutMs: 500 }),
      (error) => error.code === 'TIMEOUT',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the CLI requires a value for --json', () => {
  const cli = fileURLToPath(new URL('../bin/nha.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'native', 'verify', '--nemoclaw', '/nonexistent', '--name', 'x', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing option value/);
});
test('the generated package ships a contract test that passes', async () => {
  const root = await tempDir();
  try {
    const pack = path.join(root, 'my-harness');
    await scaffoldNativeAgent(pack, { name: 'my-harness' });
    const result = spawnSync(process.execPath, ['--test', path.join(pack, NATIVE_CONTRACT.harnessTest)], { encoding: 'utf8' });
    assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the package test is a required file', () => {
  assert.ok(NATIVE_REQUIRED_FILES.includes(NATIVE_CONTRACT.harnessTest));
  assert.ok(NATIVE_REQUIRED_FILES.includes(NATIVE_CONTRACT.harness));
});

test('nativeAgentDir stays inside the checkout agents directory', () => {
  assert.equal(nativeAgentDir('/tmp/NemoClaw', 'my-harness'), path.join('/tmp/NemoClaw', 'agents', 'my-harness'));
});

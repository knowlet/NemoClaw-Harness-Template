/** UNOFFICIAL NemoClaw-native agent packaging. Not an NVIDIA extension API or product. */
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdapterError, NOTICE } from './sdk.mjs';

/**
 * Upstream layout this packaging targets. NemoClaw's agents/<name>/ contract is
 * internal to a pinned revision, not a public NVIDIA extension API, so the
 * revision is recorded explicitly instead of being discovered at runtime.
 */
export const NATIVE_CONTRACT = Object.freeze({
  upstream: 'NVIDIA/NemoClaw',
  revision: '1eb370f20530bd1312ac86a27782ef8501b28ade',
  agentRoot: 'agents',
  manifest: 'manifest.yaml',
  policy: 'policy-additions.yaml',
  dockerfile: 'Dockerfile',
  start: 'start.sh',
  harness: 'harness.mjs',
  metadata: 'native-agent.json',
});

export const NATIVE_PACK_VERSION = 1;

const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SANDBOX_HOME = '/sandbox';
const SANDBOX_UID = 999;

function fail(code, message) { throw new AdapterError(code, message); }

function shortText(value, max, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) fail('INVALID_MANIFEST', 'Invalid ' + label);
  return value;
}

const yaml = (value) => JSON.stringify(value);
const lines = (...rows) => rows.join('\n') + '\n';

/** Normalize and validate a native agent request. */
export function defineNativeAgent(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_MANIFEST', 'Native agent input must be an object');
  if (typeof input.name !== 'string' || !AGENT_NAME.test(input.name)) fail('INVALID_MANIFEST', 'Agent name must start with a lowercase letter and use only lowercase letters, digits, and dashes (32 characters max)');
  const name = input.name;
  const harness = input.harness ?? 'echo';
  if (harness !== 'echo' && harness !== 'external') fail('INVALID_MANIFEST', 'harness must be echo or external');
  return Object.freeze({
    name,
    harness,
    displayName: shortText(input.displayName ?? name, 64, 'display name'),
    description: shortText(input.description ?? 'Unofficial ' + name + ' harness runtime', 200, 'description'),
    model: shortText(input.model ?? 'managed-model', 256, 'model'),
    home: SANDBOX_HOME,
    stateDir: SANDBOX_HOME + '/.' + name,
    installDir: '/usr/local/lib/nemo-' + name,
    harnessPath: '/usr/local/lib/nemo-' + name + '/harness.mjs',
    binaryPath: '/usr/local/bin/' + name,
  });
}

/** Render the upstream manifest.yaml that NemoClaw's agent loader reads. */
export function renderNativeManifest(input) {
  const agent = defineNativeAgent(input);
  return lines(
    '# ' + NOTICE,
    '# Native NemoClaw agent definition for the pinned upstream contract.',
    '# Upstream: ' + NATIVE_CONTRACT.upstream + '@' + NATIVE_CONTRACT.revision,
    'name: ' + agent.name,
    'display_name: ' + yaml(agent.displayName),
    'description: ' + yaml(agent.description),
    'language: nodejs',
    'license: MIT',
    'binary_path: ' + agent.binaryPath,
    'runtime:',
    '  kind: terminal',
    '  headless_command: ' + yaml('node ' + agent.harnessPath),
    '  smoke_commands:',
    '    - ' + yaml(agent.binaryPath + ' smoke'),
    'config:',
    '  dir: ' + agent.stateDir,
    '  config_file: config.json',
    '  format: json',
    'state_dirs:',
    '  - path: sessions',
    'device_pairing: false',
    'inference:',
    '  provider_type: openai_compatible',
    '  default_model: ' + yaml(agent.model),
    'mcp:',
    '  support: disabled',
    '  reason: ' + yaml('MCP is not wired for this starter harness.'),
  );
}

/** Render the baseline policy NemoClaw requires for a non-OpenClaw agent. */
export function renderNativePolicy(input) {
  const agent = defineNativeAgent(input);
  return lines(
    '# ' + NOTICE,
    '# Baseline sandbox policy for a native agent: deny by default, managed inference only.',
    'version: 1',
    'filesystem_policy:',
    '  include_workdir: true',
    '  read_only: [/usr, /lib, /etc, /proc, /dev/urandom]',
    '  read_write: [' + [SANDBOX_HOME, agent.stateDir, '/tmp', '/dev/null'].map(yaml).join(', ') + ']',
    'landlock:',
    '  compatibility: strict',
    'process:',
    '  run_as_user: sandbox',
    '  run_as_group: sandbox',
    'network_policies:',
    '  managed_inference:',
    '    name: managed_inference',
    '    endpoints:',
    '      - host: inference.local',
    '        port: 443',
    '        protocol: rest',
    '        enforcement: enforce',
    '        rules:',
    '          - allow: { method: POST, path: "/v1/chat/completions" }',
    '          - allow: { method: GET, path: "/v1/models" }',
    '    binaries:',
    '      - { path: /usr/local/bin/node }',
    '      - { path: ' + agent.installDir + '/** }',
  );
}

/**
 * Render the sandbox image. NemoClaw stages the whole checkout as the Docker
 * build context, so the COPY sources stay repository-relative.
 */
export function renderNativeDockerfile(input) {
  const agent = defineNativeAgent(input);
  return lines(
    '# ' + NOTICE,
    '# NemoClaw stages the checkout root as the build context, so paths are repository-relative.',
    'ARG BASE_IMAGE=node:24-bookworm-slim',
    'FROM ${BASE_IMAGE}',
    'USER root',
    '# The OpenShell sandbox supervisor needs the network tooling it manages namespaces with.',
    'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iproute2 nftables && rm -rf /var/lib/apt/lists/*',
    'RUN groupadd --gid ' + SANDBOX_UID + ' sandbox && useradd --uid ' + SANDBOX_UID + ' --gid sandbox --no-create-home --home-dir ' + SANDBOX_HOME + ' --shell /usr/sbin/nologin sandbox && install -d -o root -g root -m 0755 ' + agent.installDir + ' && install -d -o sandbox -g sandbox -m 0700 ' + agent.stateDir,
    'COPY ' + NATIVE_CONTRACT.agentRoot + '/' + agent.name + '/' + NATIVE_CONTRACT.harness + ' ' + agent.harnessPath,
    'COPY ' + NATIVE_CONTRACT.agentRoot + '/' + agent.name + '/launcher.sh ' + agent.binaryPath,
    'COPY ' + NATIVE_CONTRACT.agentRoot + '/' + agent.name + '/' + NATIVE_CONTRACT.start + ' /usr/local/bin/nemoclaw-start',
    'RUN chmod 0444 ' + agent.harnessPath + ' && chmod 0755 ' + agent.binaryPath + ' /usr/local/bin/nemoclaw-start && chown root:root ' + agent.harnessPath + ' ' + agent.binaryPath + ' /usr/local/bin/nemoclaw-start',
    'USER ' + SANDBOX_UID + ':' + SANDBOX_UID,
    'WORKDIR ' + SANDBOX_HOME,
    'ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]',
  );
}

/**
 * Render the agent launcher. NemoClaw's terminal-agent setup requires an
 * executable at the manifest's binary_path, so the harness gets a stable
 * launcher rather than relying on a bare interpreter name.
 */
export function renderNativeLauncher(input) {
  const agent = defineNativeAgent(input);
  return lines(
    '#!/bin/sh',
    '# ' + NOTICE,
    'exec /usr/local/bin/node ' + agent.harnessPath + ' "$@"',
  );
}

/** Render the image entrypoint. It keeps the managed sandbox alive for exec calls. */
export function renderNativeStart(input) {
  const agent = defineNativeAgent(input);
  return lines(
    '#!/bin/bash -p',
    '# ' + NOTICE,
    'set -euo pipefail',
    'unset BASH_ENV ENV',
    'umask 077',
    'export HOME=' + SANDBOX_HOME,
    'export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"',
    'install -d -m 0700 ' + agent.stateDir + ' 2>/dev/null || true',
    '# The starter harness is task-driven; keep the sandbox alive for explicit exec calls.',
    'exec /usr/bin/sleep infinity',
  );
}

/** Render the deterministic starter harness. Replace it with a real runtime. */
export function renderNativeHarness(input) {
  const agent = defineNativeAgent(input);
  return lines(
    '#!/usr/bin/env node',
    '// ' + NOTICE,
    '// Deterministic starter harness for agent "' + agent.name + '". It echoes input; it is not an LLM.',
    'let task = process.argv.slice(2).join(" ");',
    'if (task === "smoke") {',
    '  process.stdout.write("NEMO_SMOKE_OK\\n");',
    '  process.exit(0);',
    '}',
    'if (!task) {',
    '  for await (const chunk of process.stdin) {',
    '    task += chunk;',
    '    if (Buffer.byteLength(task) > 1048576) throw new Error("Task exceeds 1 MiB");',
    '  }',
    '}',
    'process.stdout.write("Echo: " + task + "\\n");',
  );
}

/** Render the dependency record NemoClaw keeps beside each agent. */
export function renderNativeDependencyReview(input) {
  const agent = defineNativeAgent(input);
  return lines(
    '# ' + agent.name + ' Dependency Review',
    '',
    'This record covers the sandbox image built from agents/' + agent.name + '/Dockerfile.',
    '',
    '- Base image default: node:24-bookworm-slim (pin a digest for release builds).',
    '- Runtime payload: a dependency-free script at ' + agent.harnessPath + ' behind the launcher',
    '  ' + agent.binaryPath + ' declared as manifest binary_path.',
    '- Installed packages: ca-certificates, iproute2, and nftables from Debian (the OpenShell',
    '  sandbox supervisor needs them to create and enforce its network namespace).',
    '- Lockfile: none; there is no npm dependency graph to resolve.',
    '- Network policy: deny by default with only the managed inference route allowed.',
    '',
    'Changing the base image, the harness, or the policy requires a new image build and a',
    'renewed review. NemoClaw does not verify this file; it is operator documentation.',
  );
}

/** Render the packaging metadata used for install and verification. */
export function renderNativeMetadata(input) {
  const agent = defineNativeAgent(input);
  return JSON.stringify({
    pack: 'nemoclaw-native-agent',
    packVersion: NATIVE_PACK_VERSION,
    unofficial: true,
    contract: { upstream: NATIVE_CONTRACT.upstream, revision: NATIVE_CONTRACT.revision },
    agent: {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: agent.model,
      harness: agent.harness,
      harnessPath: agent.harnessPath,
      stateDir: agent.stateDir,
    },
  }, null, 2) + '\n';
}

/** Build the complete file map for a native agent package. */
export function renderNativePackage(input) {
  const agent = defineNativeAgent(input);
  return Object.freeze({
    [NATIVE_CONTRACT.manifest]: renderNativeManifest(agent),
    [NATIVE_CONTRACT.policy]: renderNativePolicy(agent),
    [NATIVE_CONTRACT.dockerfile]: renderNativeDockerfile(agent),
    [NATIVE_CONTRACT.start]: renderNativeStart(agent),
    'launcher.sh': renderNativeLauncher(agent),
    [NATIVE_CONTRACT.harness]: renderNativeHarness(agent),
    'dependency-review.md': renderNativeDependencyReview(agent),
    [NATIVE_CONTRACT.metadata]: renderNativeMetadata(agent),
  });
}

export function nativeAgentDir(nemoclawRoot, name) {
  return path.join(path.resolve(nemoclawRoot), NATIVE_CONTRACT.agentRoot, name);
}

async function exists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function assertNativeCheckout(nemoclawRoot) {
  const root = path.resolve(nemoclawRoot);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); }
  catch { fail('NOT_A_CHECKOUT', 'NemoClaw source checkout not found at the supplied path'); }
  if (manifest.name !== 'nemoclaw' || !(await exists(path.join(root, NATIVE_CONTRACT.agentRoot)))) {
    fail('NOT_A_CHECKOUT', 'The supplied path is not a NemoClaw source checkout');
  }
  return root;
}

/** Create a native agent package. The destination must not already exist. */
export async function scaffoldNativeAgent(destination, input = {}) {
  const agent = defineNativeAgent(input);
  const output = path.resolve(destination);
  if (await exists(output)) fail('DESTINATION_EXISTS', 'Refusing to overwrite an existing destination');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  try {
    const files = renderNativePackage(agent);
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(output, name), content, { flag: 'wx' });
    }
    return { directory: output, files: Object.keys(files).sort(), agent };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

/** Read and validate a native agent package built by this SDK. */
export async function readNativePackage(directory) {
  const target = path.resolve(directory);
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(target, NATIVE_CONTRACT.metadata), 'utf8')); }
  catch { fail('INVALID_PACKAGE', 'Not a native agent package: missing ' + NATIVE_CONTRACT.metadata); }
  if (metadata?.pack !== 'nemoclaw-native-agent') fail('INVALID_PACKAGE', 'Unsupported native agent package format');
  if (metadata.packVersion !== NATIVE_PACK_VERSION) fail('INVALID_PACKAGE', 'Unsupported native agent package version');
  const name = metadata.agent?.name;
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) fail('INVALID_PACKAGE', 'Invalid agent name in package metadata');
  for (const required of [NATIVE_CONTRACT.manifest, NATIVE_CONTRACT.policy, NATIVE_CONTRACT.dockerfile, NATIVE_CONTRACT.start, NATIVE_CONTRACT.harness]) {
    if (!(await exists(path.join(target, required)))) fail('INVALID_PACKAGE', 'Native agent package is missing ' + required);
  }
  return { directory: target, agent: metadata.agent, metadata };
}

/**
 * Install a native agent package into a NemoClaw source checkout. NemoClaw's
 * loader scans <checkout>/agents for directories that contain manifest.yaml,
 * so placing the package there is the upstream registration step.
 */
export async function installNativeAgent(directory, { nemoclawRoot, replace = false } = {}) {
  if (!nemoclawRoot) fail('USAGE', 'A NemoClaw source checkout is required');
  const pack = await readNativePackage(directory);
  const root = await assertNativeCheckout(nemoclawRoot);
  const target = nativeAgentDir(root, pack.agent.name);
  if (await exists(target)) {
    if (!replace) fail('DESTINATION_EXISTS', 'That agent is already installed; pass --replace to overwrite it');
    await rm(target, { recursive: true, force: true });
  }
  await cp(pack.directory, target, { recursive: true, errorOnExist: true, force: false });
  return { agentDir: target, name: pack.agent.name, upstream: NATIVE_CONTRACT.upstream, revision: NATIVE_CONTRACT.revision };
}

/** The probe NemoClaw runs to prove its loader accepts the installed agent. */
export function nativeVerifySource() {
  return lines(
    '// UNOFFICIAL probe: exercises the real pinned NemoClaw agent loader.',
    'const path = require("node:path");',
    'const { createRequire } = require("node:module");',
    'const root = process.cwd();',
    'const name = process.argv[2];',
    'const requireFrom = createRequire(path.join(root, "package.json"));',
    'const result = { unofficial: true, root, name, loaderAccepted: false, deploymentVerified: false };',
    'try {',
    '  const defs = requireFrom(path.join(root, "dist/lib/agent/defs.js"));',
    '  const onboard = requireFrom(path.join(root, "dist/lib/agent/onboard.js"));',
    '  const workload = requireFrom(path.join(root, "dist/lib/onboard/workload/source.js"));',
    '  const listed = defs.listAgents().includes(name);',
    '  const agent = defs.loadAgent(name);',
    '  const policyPath = onboard.getAgentPolicyPath(agent);',
    '  const source = workload.resolveSandboxWorkloadSource({',
    '    agentName: name,',
    '    legacyDockerfilePath: agent.dockerfilePath || "",',
    '    runtime: { driverName: "docker", managedImageSelectionPolicy: "prefer-managed", legacyDockerfileBuilds: true, managedImages: null },',
    '    catalog: {},',
    '  });',
    '  result.listed = listed;',
    '  result.loaderAccepted = listed && source.kind === "legacy-dockerfile" && source.dockerfilePath === agent.dockerfilePath;',
    '  result.dockerfile = agent.dockerfilePath;',
    '  result.policyAdditions = policyPath;',
    '  result.runtime = agent.runtime;',
    '  result.configDir = agent.configPaths.dir;',
    '  result.workload = { kind: source.kind, dockerfilePath: source.dockerfilePath, reason: source.reason };',
    '} catch (error) {',
    '  result.error = error && error.message ? String(error.message) : String(error);',
    '}',
    'process.stdout.write(JSON.stringify(result, null, 2) + "\\n");',
    'process.exitCode = result.loaderAccepted ? 0 : 1;',
  );
}

/**
 * Run the real NemoClaw loader against an installed agent. This proves the
 * loader accepts the package and selects our Dockerfile. It does not prove a
 * deployment: onboarding and sandbox execution are reported separately.
 */
export async function verifyNativeAgent({ nemoclawRoot, name, timeoutMs = 120000 } = {}) {
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) fail('USAGE', 'A valid agent name is required');
  const root = await assertNativeCheckout(nemoclawRoot);
  if (!(await exists(path.join(root, 'dist/lib/agent/defs.js')))) {
    fail('NOT_BUILT', 'The NemoClaw checkout has no compiled CLI; run its build:cli step first');
  }
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nha-native-verify-'));
  const probe = path.join(workspace, 'verify.cjs');
  await writeFile(probe, nativeVerifySource());
  try {
    const child = spawn(process.execPath, [probe, name], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    const code = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new AdapterError('VERIFY_FAILED', 'Cannot execute the NemoClaw checkout')));
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    let report;
    try { report = JSON.parse(Buffer.concat(out).toString('utf8').trim()); }
    catch { fail('VERIFY_FAILED', 'The NemoClaw loader probe produced no usable report (exit ' + String(code) + ')'); }
    return report;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

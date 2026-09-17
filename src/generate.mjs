/** UNOFFICIAL template generation. Generated manifests are this project's schema, not NVIDIA's. */
import { mkdir, readFile, writeFile, mkdtemp, rm, lstat, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError, createAdapter, defineAdapter, NOTICE } from './sdk.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
export function renderPolicy(input) {
  const adapter = defineAdapter(input);
  return `# UNOFFICIAL OpenShell BYOC baseline. Not a NemoClaw policy preset.\nversion: 1\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr, /lib, /etc, /opt, /proc, /dev/urandom]\n  read_write: [${JSON.stringify(adapter.state.home)}, ${JSON.stringify(adapter.state.workspace)}, /tmp, /dev/null]\nlandlock:\n  compatibility: hard_requirement\nnetwork_policies: {}\n`;
}
export function renderDockerfile(input) {
  const adapter = defineAdapter(input);
  return `# UNOFFICIAL. Supply a reviewed Debian-based Node 24.5+ image digest for releases.\nARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iproute2 \\\n    && rm -rf /var/lib/apt/lists/*\nWORKDIR /opt/nha\nCOPY --chown=root:root . /opt/nha/\nRUN mkdir -p /etc/nha ${adapter.state.home} ${adapter.state.workspace} \\\n    && cp /opt/nha/adapter.json /etc/nha/adapter.json \\\n    && chmod -R go-w /opt/nha /etc/nha \\\n    && chmod 0444 /etc/nha/adapter.json \\\n    && chown -R 1000:1000 ${adapter.state.home} ${adapter.state.workspace}\nENV NODE_USE_ENV_PROXY=1\nLABEL org.opencontainers.image.vendor="knowlet (independent community project)" \\\n      dev.knowlet.nha.unofficial="true"\nUSER 1000:1000\nWORKDIR ${adapter.state.workspace}\n# OpenShell replaces ENTRYPOINT; the launch command MUST be passed after --.\nENTRYPOINT ["/usr/local/bin/node", "/opt/nha/bin/nha.mjs", "exec", "/etc/nha/adapter.json", "--managed"]\n`;
}
export function renderDeepSeekPatch(input) {
  const adapter = defineAdapter(input);
  // JSON is a YAML subset. These are Cordis patch rows, NOT a guessed model: config.
  return `${JSON.stringify([
    { id: 'settings', disabled: true },
    { id: 'llm-pi-ai', disabled: false, config: { providers: { 'nha-managed': {
      api: 'openai-completions', baseURL: adapter.inference.baseUrl, apiKeyEnv: 'NHA_INFERENCE_TOKEN',
      models: [{ id: adapter.inference.model }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'nha-managed', model: adapter.inference.model } },
    ...['hmr', 'tool-bash', 'tool-pwsh', 'skill-filesystem', 'session-telemetry-otel'].map((id) => ({ id, disabled: true })),
  ], null, 2)}\n`;
}

/** Create a fresh scaffold with an exclusive destination claim; never overwrite existing files. */
export async function scaffold(destination, { name = 'my-harness', model = 'managed-model' } = {}) {
  const adapter = createAdapter(name, model);
  const output = path.resolve(destination);
  try { await lstat(output); throw new AdapterError('DESTINATION_EXISTS', 'Refusing to overwrite an existing destination'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(output), { recursive: true });
  const temp = await mkdtemp(path.join(path.dirname(output), '.nha-init-'));
  try {
    for (const dir of ['src', 'bin', 'examples/echo']) await cp(path.join(root, dir), path.join(temp, dir), { recursive: true });
    for (const file of ['LICENSE', 'NOTICE']) await cp(path.join(root, file), path.join(temp, file));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    pkg.name = name;
    pkg.description = `UNOFFICIAL ${name} harness scaffold based on knowlet's independent adapter SDK`;
    pkg.scripts = { demo: 'node bin/nha.mjs demo', validate: 'node bin/nha.mjs validate adapter.json', doctor: 'node bin/nha.mjs doctor', test: 'node --test test/*.test.mjs' };
    delete pkg.repository;
    await writeFile(path.join(temp, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    const lock = { name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name, version: pkg.version, license: pkg.license, bin: pkg.bin, engines: pkg.engines } } };
    await writeFile(path.join(temp, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(path.join(temp, 'adapter.json'), `${JSON.stringify(adapter, null, 2)}\n`);
    await writeFile(path.join(temp, 'policy.yaml'), renderPolicy(adapter));
    await writeFile(path.join(temp, 'Dockerfile'), renderDockerfile(adapter));
    await cp(path.join(root, 'examples/echo/agent.mjs'), path.join(temp, 'agent.mjs'));
    await mkdir(path.join(temp, 'test'));
    const suite = { version: 'harness-suite/v1', name: 'starter-harness', cases: [
      { name: 'basic task', task: 'hello', expect: { stdout: 'Echo: hello\n' } },
      { name: 'Unicode', task: '繁體中文 🦖', expect: { stdout: 'Echo: 繁體中文 🦖\n' } },
      { name: 'literal shell input', task: '$(echo NOT_EXECUTED); \'single\' "double"', expect: { stdout: 'Echo: $(echo NOT_EXECUTED); \'single\' "double"\n' } },
    ] };
    await writeFile(path.join(temp, 'test/suite.json'), JSON.stringify(suite, null, 2) + '\n');
    await writeFile(path.join(temp, 'test/harness.test.mjs'), `// UNOFFICIAL local contract test. Replace the command and cases when adapting a real harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { runSuite } from '../src/index.mjs';
test('harness contract', async () => {
  const adapter = JSON.parse(await readFile(new URL('../adapter.json', import.meta.url), 'utf8'));
  adapter.runtime.command = [process.execPath, fileURLToPath(new URL('../agent.mjs', import.meta.url))];
  const suite = JSON.parse(await readFile(new URL('./suite.json', import.meta.url), 'utf8'));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'harness-contract-'));
  try {
    const report = await runSuite(suite, { adapter, cwd: tmp, home: tmp });
    assert.equal(report.ok, true, JSON.stringify(report));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
`);

    await writeFile(path.join(temp, '.dockerignore'), '.git\nnode_modules\n.env*\n*.tgz\n*.log\n');
    await writeFile(path.join(temp, 'README.md'), `# ${name} — UNOFFICIAL\n\n${NOTICE}\n\nThe starter agent echoes stdin; it is NOT an LLM. Replace agent.mjs or adapter.json runtime.command with your reviewed harness.\n\nTry locally: \`printf 'hello' | node agent.mjs\`. This has no sandbox.\n\nValidate: \`node bin/nha.mjs validate adapter.json\`. Run \`npm test\` for the generated harness contract suite; edit test/suite.json and test/harness.test.mjs to adapt it.\n\nBuild a development image: \`docker build --build-arg BASE_IMAGE=node:24-bookworm-slim -t ${name}:dev .\`. Tags and apt packages are mutable; release builds require reviewed image digests and package provenance.\n\nGenerate an explicit launch plan: \`node bin/nha.mjs plan --name ${name} --image ${name}:dev --dev-image --policy policy.yaml --task hello\`. The gateway and any inference route must already exist.\n\nThe state classification is descriptive; this SDK does not implement NemoClaw snapshots or registration.\n`);
    // mkdir is the final exclusive claim; rename alone could replace an empty directory.
    await mkdir(output);
    // Node 24 refuses an existing destination directory with errorOnExist.
    // Claim the root once, then copy only children to fresh paths.
    for (const name of await readdir(temp)) {
      await cp(path.join(temp, name), path.join(output, name), { recursive: true, errorOnExist: true, force: false });
    }
    return { directory: output, adapter };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

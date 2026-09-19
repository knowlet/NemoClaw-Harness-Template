#!/usr/bin/env node
// TypeScript source of truth; declarations are emitted by tsc.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError, VERSION, NOTICE, createAdapter, loadAdapter, assertManagedFile, runHarness, buildOpenShellPlan, launchOpenShell, scaffold, renderPolicy, renderDockerfile, renderDeepSeekPatch } from '../src/index.js';

function parse(args: string[]) {
  const positional: string[] = [], flags: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (!['managed', 'allow-host', 'dev-image', 'name', 'model', 'image', 'policy', 'task', 'task-file', 'output', 'help', 'version', 'nemoclaw', 'replace', 'display-name', 'description', 'harness', 'json'].includes(key) || key in flags) throw new AdapterError('USAGE', 'Unknown or repeated option');
    if (['managed', 'allow-host', 'dev-image', 'help', 'version', 'replace', 'json'].includes(key)) flags[key] = true;
    else {
      if (args[i + 1] === undefined) throw new AdapterError('USAGE', 'Missing option value');
      flags[key] = args[++i];
    }
  }
  return { positional, flags };
}
function help() {
  console.log(`${NOTICE}\n\nUsage: nha <command>\n  demo                              Run a deterministic local echo (no sandbox/LLM)\n  init <directory> [--name NAME] [--model MODEL]\n  validate <adapter.json>\n  render <adapter.json> --output NEW_DIRECTORY\n  exec <adapter.json> (--managed | --allow-host) (--task TEXT | --task-file FILE)\n  plan --name NAME --image IMAGE --policy FILE --task TEXT [--dev-image]\n  launch <same arguments as plan>    Explicitly execute the OpenShell BYOC command\n  native init|install|verify ...      Package a harness as a NemoClaw-native agents/<name> runtime\n  test <suite.json> --adapter FILE (--allow-host | --managed) [--json FILE] [--junit FILE]\n  doctor                            Check local prerequisites; no changes\n  --version\n\nNative packaging targets one pinned NemoClaw revision and never publishes anything.\n`);
}
async function main(): Promise<void> {
  if (process.argv[2] === 'test') { const { testCommand } = await import('./test.js'); return testCommand(process.argv.slice(3)); }
  if (process.argv[2] === 'native') { const { nativeCommand } = await import('./native.js'); return nativeCommand(process.argv.slice(3)); }
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, filename] = positional;
  if (flags.version) { console.log(`nha ${VERSION} — ${NOTICE}`); return; }
  if (!command || flags.help) { help(); return; }
  if (command === 'demo') {
    console.error('UNOFFICIAL demo: local echo only; no sandbox and no inference request.');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nha-demo-'));
    try {
      const adapter: any = structuredClone(createAdapter('echo'));
      adapter.runtime.command = [process.execPath, fileURLToPath(new URL('../../examples/echo/agent.mjs', import.meta.url))];
      const result = await runHarness(adapter, 'Hello, harness!', { cwd: dir, home: dir });
      process.stdout.write(result.stdout);
    } finally { await rm(dir, { recursive: true, force: true }); }
    return;
  }
  if (command === 'doctor') {
    const binaries = Object.fromEntries(['nemoclaw', 'openshell', 'docker', 'podman', 'nerdctl'].map((bin) => {
      const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      return [bin, { available: !result.error && result.status === 0, version: result.status === 0 ? result.stdout.trim().split('\n')[0] : null }];
    }));
    console.log(JSON.stringify({ notice: NOTICE, node: process.version, platform: process.platform, arch: process.arch, binaries, liveSandboxVerified: false }, null, 2));
    return;
  }
  if (command === 'init') {
    if (!filename) throw new AdapterError('USAGE', 'init requires a destination');
    console.log(JSON.stringify(await scaffold(filename, { name: flags.name, model: flags.model }), null, 2));
    return;
  }
  if (command === 'plan' || command === 'launch') {
    const options: any = { name: flags.name, image: flags.image, policy: flags.policy, task: flags.task, allowMutableImage: flags['dev-image'] === true };
    const commands = buildOpenShellPlan(options);
    if (command === 'plan') {
      console.log(JSON.stringify({ notice: NOTICE, integration: 'OpenShell BYOC, not registered NemoClaw runtime', developmentImage: flags['dev-image'] === true, commands, prerequisites: ['Compatible OpenShell gateway', 'Image available to the gateway', 'Reviewed policy', 'An existing NemoClaw-compatible inference.local route for LLM tasks'] }, null, 2));
    } else {
      console.error(`${NOTICE}\nCreating an OpenShell sandbox. This does not configure inference or upstream NemoClaw registration.`);
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try { await launchOpenShell(options, { signal: controller.signal }); }
      finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    }
    return;
  }
  if (!['validate', 'render', 'exec'].includes(command) || !filename) throw new AdapterError('USAGE', 'Unknown command or missing adapter file');
  if (command === 'exec' && Boolean(flags.managed) === Boolean(flags['allow-host'])) throw new AdapterError('USAGE', 'Choose exactly one: --managed or --allow-host');
  const adapter = command === 'exec' && flags.managed ? await assertManagedFile(filename) : await loadAdapter(filename);
  if (command === 'validate') { console.log(`${adapter.metadata.name}: valid ${adapter.apiVersion} (UNOFFICIAL)`); return; }
  if (command === 'render') {
    if (!flags.output) throw new AdapterError('USAGE', 'render requires --output NEW_DIRECTORY');
    await mkdir(flags.output);
    for (const [name, content] of [['policy.yaml', renderPolicy(adapter)], ['Dockerfile', renderDockerfile(adapter)], ['managed.cordis.patch.yml', renderDeepSeekPatch(adapter)]]) await writeFile(path.join(flags.output, name), content, { flag: 'wx' });
    console.log(`Rendered UNOFFICIAL build inputs to ${flags.output}; the DeepSeek patch remains experimental.`);
    return;
  }
  if (Boolean(flags.task !== undefined) === Boolean(flags['task-file'])) throw new AdapterError('USAGE', 'Choose exactly one: --task or --task-file');
  if (flags.managed && (typeof process.getuid !== 'function' || process.getuid() === 0)) throw new AdapterError('ROOT_PROCESS', 'Managed harnesses must run as non-root');
  if (flags.managed) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 5)) throw new AdapterError('NODE_VERSION', 'Managed launch requires Node 24.5+ for built-in proxy support');
  } else console.error('WARNING: --allow-host runs executable harness code on this host WITHOUT a sandbox.');
  const task = flags['task-file'] ? await readFile(flags['task-file'], 'utf8') : flags.task;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await runHarness(adapter, task, { signal: controller.signal, ...(flags['allow-host'] ? { cwd: process.cwd(), home: process.env.HOME ?? process.cwd() } : {}) });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
main().catch((error) => {
  // Do not dump arbitrary exception objects, argv, task bodies, environment, or provider response bodies.
  console.error(error instanceof AdapterError ? `${error.code}: ${error.message}` : 'FAILED: operation failed; check file paths, permissions, and the documented prerequisites.');
  process.exitCode = 1;
});

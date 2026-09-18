// TypeScript source of truth; declarations are emitted by tsc.
// UNOFFICIAL explicit-execution suite CLI. JSON suite files contain no executable hooks.
import { readFile, stat, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AdapterError, assertManagedFile, loadAdapter, runSuite, toJUnit } from '../src/index.js';
export async function testCommand(args) {
  const [suiteFile, ...rest] = args;
  const flags = {};
  if (!suiteFile || suiteFile.startsWith('--')) throw new AdapterError('USAGE', 'test requires a suite JSON file');
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (!['--adapter', '--allow-host', '--managed', '--json', '--junit'].includes(f) || f in flags) throw new AdapterError('USAGE', 'Unknown or repeated test option');
    flags[f] = ['--allow-host', '--managed'].includes(f) ? true : rest[++i];
    if (flags[f] === undefined) throw new AdapterError('USAGE', 'Missing test option value');
  }
  if (!flags['--adapter'] || Boolean(flags['--managed']) === Boolean(flags['--allow-host'])) throw new AdapterError('USAGE', 'Supply --adapter and exactly one execution mode');
  if ((await stat(suiteFile)).size > 8388608) throw new AdapterError('INVALID_SUITE', 'Suite exceeds 8 MiB');
  let input;
  try { input = JSON.parse(await readFile(suiteFile, 'utf8')); } catch { throw new AdapterError('INVALID_SUITE', 'Suite must be valid JSON'); }
  const managed = flags['--managed'] === true;
  if (managed && (process.platform !== 'linux' || process.getuid?.() === 0)) throw new AdapterError('ROOT_PROCESS', 'Managed tests require a non-root Linux process');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (managed && (major < 24 || (major === 24 && minor < 5))) throw new AdapterError('NODE_VERSION', 'Managed tests require Node 24.5+');
  const adapter = await (managed ? assertManagedFile(flags['--adapter']) : loadAdapter(flags['--adapter']));
  const temp = managed ? null : await mkdtemp(path.join(os.tmpdir(), 'harness-suite-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  try {
    if (temp) {
      console.error('UNOFFICIAL: --allow-host executes trusted harness code WITHOUT a sandbox; workspace is temporary.');
      await mkdir(path.join(temp, 'home')); await mkdir(path.join(temp, 'workspace'));
    }
    const report = await runSuite(input, { adapter, signal: controller.signal, ...(temp ? { home: path.join(temp, 'home'), cwd: path.join(temp, 'workspace') } : {}) });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    for (const [f, content] of [['--json', json], ['--junit', toJUnit(report)]]) {
      if (flags[f]) await writeFile(flags[f], content, { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(json); process.exitCode = report.ok ? 0 : 1;
  } finally {
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

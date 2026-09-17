// UNOFFICIAL EXPERIMENTAL adapter for a separately reviewed DeepSeek runtime image.
// This file is copied to /opt/nha/deepseek-launch.mjs by prepare.mjs.
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
const home = '/sandbox/.dsh';
try {
  if (process.env.DSH_HOME !== home || process.env.NHA_INFERENCE_TOKEN !== 'openshell' || process.getuid?.() === 0) throw new Error('Invalid managed environment');
  for (const file of [home, `${home}/profiles`, `${home}/profiles/headless`, `${home}/profiles/headless/package.json`, `${home}/profiles/headless/cordis.patch.yml`, '/etc/nha/managed.cordis.patch.yml']) {
    const st = await lstat(file);
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || (!st.isDirectory() && (st.mode & 0o222))) throw new Error('Untrusted configuration');
  }
  let task = '';
  for await (const chunk of process.stdin) {
    task += chunk;
    if (Buffer.byteLength(task) > 16384) throw new Error('Task too large for DSH argv');
  }
  if (!task || task.startsWith('-') || task.includes('\0')) throw new Error('Invalid DSH task');
  // No arbitrary flags, external profiles, or additional user overlays are accepted here.
  // The outer SDK owns the process group, deadline, and combined output limit.
  const child = spawn('/usr/local/bin/dsh', ['--profile', 'headless', '--patch', '/etc/nha/managed.cordis.patch.yml', task], { shell: false, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  child.once('error', () => { console.error('DSH_START_FAILED'); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
} catch {
  console.error('DSH_PREFLIGHT_FAILED: check immutable configuration, task size, and the reviewed runtime contract');
  process.exitCode = 1;
}

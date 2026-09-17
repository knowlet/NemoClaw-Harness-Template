// Use a neutral, stable artifact filename; the npm package keeps its scoped identity.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const temp = await mkdtemp(path.join(os.tmpdir(), 'harness-pack-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { encoding: 'utf8', timeout: 30000 }));
  await mkdir('dist', { recursive: true });
  await copyFile(path.join(temp, packed.filename), 'dist/harness-sdk.tgz');
  console.log('dist/harness-sdk.tgz');
} finally { await rm(temp, { recursive: true, force: true }); }

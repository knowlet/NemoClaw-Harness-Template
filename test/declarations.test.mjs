import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertDeclarationSnapshots } from '../scripts/test-declarations.mjs';

async function fixture(t, files, manifest) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nha-declarations-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const packageRoot = path.join(temp, 'package');
  const snapshotRoot = path.join(temp, 'snapshots');
  async function write(root, file, content) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await write(packageRoot, 'package.json', JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) {
    await write(packageRoot, file, content);
    await write(snapshotRoot, file + '.snap', content);
  }
  return { packageRoot, snapshotRoot, write, check: () => assertDeclarationSnapshots(packageRoot, snapshotRoot) };
}

test('public declaration snapshots detect byte changes in both entry points and all dependencies', async (t) => {
  const snapshotRoot = new URL('./public-api/dist/src/', import.meta.url);
  const files = {};
  for (const name of await readdir(snapshotRoot)) {
    files['dist/src/' + name.slice(0, -5)] = await readFile(new URL(name, snapshotRoot));
  }
  const { packageRoot, write, check } = await fixture(t, files, {
    types: './dist/src/index.d.ts',
    exports: { '.': { types: './dist/src/index.d.ts' }, './testing': { types: './dist/src/testing.d.ts' } },
  });
  await write(packageRoot, 'dist/src/private.d.ts', 'export declare const internal: unknown;\n');
  await check();
  for (const [file, content] of Object.entries(files)) {
    await write(packageRoot, file, Buffer.concat([content, Buffer.from('\n')]));
    await assert.rejects(check, (error) => error.message.includes(`Public declaration changed: ${file}`));
    await write(packageRoot, file, content);
  }
  await write(packageRoot, 'dist/src/types.d.ts', files['dist/src/types.d.ts'].toString()
    .replace('max_tokens?: number;', 'max_tokens?: number | string;'));
  await assert.rejects(check, /Public declaration changed: dist\/src\/types\.d\.ts/);
  await rm(path.join(packageRoot, 'dist/src/types.d.ts'));
  await assert.rejects(check, /Missing declaration dependency: \.\/types\.js/);
});

test('new and removed recursive dependencies require explicit snapshot updates', async (t) => {
  const entry = 'export type { Value } from "./nested/value.js";\n';
  const value = 'export interface Value { next?: import("../index.js").Value }\n';
  const { packageRoot, snapshotRoot, write, check } = await fixture(t, {
    'index.d.ts': entry,
    'nested/value.d.ts': value,
  }, { types: './index.d.ts' });
  await check(); // Cyclic declaration references are visited only once.

  const extended = value + 'export type Extra = import("../extra.js").Extra;\n';
  const extra = 'export interface Extra { enabled: boolean }\n';
  await write(packageRoot, 'nested/value.d.ts', extended);
  await write(snapshotRoot, 'nested/value.d.ts.snap', extended);
  await write(packageRoot, 'extra.d.ts', extra);
  await assert.rejects(check, /Missing public declaration snapshot: extra\.d\.ts/);
  await write(snapshotRoot, 'extra.d.ts.snap', extra);
  await check();

  await write(packageRoot, 'nested/value.d.ts', value);
  await write(snapshotRoot, 'nested/value.d.ts.snap', value);
  await assert.rejects(check, /Public declaration file set changed/);
  await rm(path.join(snapshotRoot, 'extra.d.ts.snap'));
  await check();
});

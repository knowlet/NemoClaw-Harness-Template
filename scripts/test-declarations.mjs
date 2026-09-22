import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const snapshots = fileURLToPath(new URL('../test/public-api/', import.meta.url));
const declaration = /\.d\.(?:ts|mts|cts)$/;

// Compare only public declarations and their dependencies, not private implementation types.
export async function assertDeclarationSnapshots(packageRoot, snapshotRoot = snapshots) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const pending = [];
  function entryPoints(value, types = false) {
    if (typeof value === 'string') {
      if (types || declaration.test(value)) pending.push(value);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) entryPoints(child, types || key === 'types');
    }
  }
  entryPoints(manifest.types, true);
  entryPoints(manifest.exports);
  assert.ok(pending.length, 'Package must expose public declaration entry points');

  async function resolveDependency(file, specifier) {
    const relative = path.posix.join(path.posix.dirname(file), specifier);
    const candidates = declaration.test(relative) ? [relative]
      : /\.[cm]?[jt]s$/.test(relative) ? [relative.replace(/\.(?:[jt]s|([cm])[jt]s)$/, (_, kind) => `.d.${kind || ''}ts`)]
        : [relative + '.d.ts', path.posix.join(relative, 'index.d.ts')];
    for (const candidate of candidates) {
      if (await stat(path.join(packageRoot, candidate)).then((entry) => entry.isFile(), (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })) return candidate;
    }
    assert.fail(`Missing declaration dependency: ${specifier} from ${file}`);
  }

  const seen = new Set();
  while (pending.length) {
    const file = path.posix.normalize(pending.pop());
    assert.ok(!path.posix.isAbsolute(file) && !file.startsWith('../') && declaration.test(file), `Invalid public declaration path: ${file}`);
    if (seen.has(file)) continue;
    seen.add(file);
    const actual = await readFile(path.join(packageRoot, file));
    const expected = await readFile(path.join(snapshotRoot, file + '.snap')).catch((error) => {
      if (error.code === 'ENOENT') assert.fail(`Missing public declaration snapshot: ${file}. Review the API change and explicitly add its snapshot.`);
      throw error;
    });
    assert.ok(actual.equals(expected), `Public declaration changed: ${file}. Review the API change and explicitly update its snapshot.`);
    // Emitted imports, exports, import()/require() types, and triple-slash path references.
    const references = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\b(?:import|require)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]|\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/g;
    for (const match of actual.toString('utf8').matchAll(references)) {
      pending.push(await resolveDependency(file, match[1] || match[2] || match[3]));
    }
  }
  const expectedFiles = (await readdir(snapshotRoot, { recursive: true }))
    .filter((file) => file.endsWith('.snap')).map((file) => file.slice(0, -5).split(path.sep).join('/')).sort();
  assert.deepEqual([...seen].sort(), expectedFiles, 'Public declaration file set changed. Review the API change and explicitly update snapshots.');
}

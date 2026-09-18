// Dependency-free syntax/JSON/whitespace/relative-doc-link checks; not ESLint.
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
let checked = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'coverage', '.upstream', 'reports'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(file); continue; }
    if (!/\.(mjs|mts|ts|json|md|yml|yaml)$/.test(file)) continue;
    const text = await readFile(file, 'utf8'); checked++;
    if (!text.endsWith('\n') || /[ \t]+$/m.test(text)) throw new Error(`Whitespace: ${file}`);
    if (file.endsWith('.json')) JSON.parse(text);
    if (file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    if (/^README.*\.md$/.test(entry.name) && /knowlet-nemoclaw-harness/.test(text)) throw new Error(`Maintainer-prefixed artifact path in README: ${file}`);
    if (file.endsWith('.md')) {
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1].split('#')[0];
        if (!link || /^[a-z]+:/.test(link) || link.startsWith('/')) continue;
        await stat(path.resolve(path.dirname(file), link));
      }
    }
  }
}
await walk(root);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error('Runtime must remain dependency-free');
for (const file of ['README.md', 'README.zh-TW.md', 'NOTICE', 'docs/SDK.md', 'docs/NATIVE.md', 'docs/QUICKSTART.md']) {
  if (!/UNOFFICIAL|非官方/.test(await readFile(file, 'utf8'))) throw new Error(`Missing notice: ${file}`);
}
// Native packaging is revision-locked; every published claim must name the same upstream revision.
const pinned = /revision: '([0-9a-f]{40})'/.exec(await readFile('src/native.mjs', 'utf8'))?.[1];
if (!pinned) throw new Error('src/native.mjs must declare the pinned NemoClaw revision');
for (const file of ['README.md', 'README.zh-TW.md', 'docs/NATIVE.md', 'docs/QUICKSTART.md', '.github/workflows/runtime-integration.yml', '.github/workflows/quickstart.yml']) {
  if (!(await readFile(file, 'utf8')).includes(pinned)) throw new Error(`Pinned NemoClaw revision missing from ${file}`);
}
console.log(`Lint passed: ${checked} source/doc files (syntax, JSON, whitespace, local links, notices, pinned revision)`);

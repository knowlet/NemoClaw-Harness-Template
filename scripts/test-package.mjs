// Test the actual npm tarball in an empty offline consumer, not just the source tree.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'nha-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const packed = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], process.cwd()))[0];
  const consumer = path.join(temp, 'consumer'); await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"name":"clean-consumer","private":true,"type":"module"}\n');
  run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)], consumer);
  assert.match(run(process.execPath, ['--input-type=module', '-e', "import {createAdapter} from '@knowlet/nemoclaw-harness-sdk'; console.log(createAdapter('consumer').metadata.unofficial)"], consumer), /true/);
  assert.match(run(process.execPath, ['--input-type=module', '-e', "import {SUITE_VERSION} from '@knowlet/nemoclaw-harness-sdk/testing'; console.log(SUITE_VERSION)"], consumer), /harness-suite\/v1/);
  const cli = path.join(consumer, 'node_modules/@knowlet/nemoclaw-harness-sdk/bin/nha.mjs');
  assert.match(run(process.execPath, [cli, 'demo'], consumer), /Echo: Hello, harness!/);
  const generated = path.join(temp, 'generated');
  run(process.execPath, [cli, 'init', generated, '--name', 'packed-harness'], consumer);
  run(npm, ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], generated);
  assert.match(run(process.execPath, ['bin/nha.mjs', 'validate', 'adapter.json'], generated), /valid/);
  assert.match(run(process.execPath, ['bin/nha.mjs', 'demo'], generated), /Echo: Hello, harness!/);
  assert.match(run(npm, ['test'], generated), /harness contract/);
  const lock = JSON.parse(await readFile(path.join(generated, 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, 'packed-harness');
  assert.ok(packed.files.some((file) => file.path === 'dist/src/index.d.ts'));
  // Consumers using classic node resolution ignore exports and follow the top-level types
  // field. When it points at a deleted declaration, TypeScript falls through to the
  // implementation sources and type-checks them under the consumer compiler options.
  const tsc = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  await writeFile(path.join(consumer, 'consumer.ts'), "import { createAdapter } from '@knowlet/nemoclaw-harness-sdk';\nconst adapter = createAdapter('typed');\nvoid adapter.metadata.name;\n");
  for (const moduleResolution of ['node', 'NodeNext']) {
    const config = path.join(consumer, 'tsconfig.' + moduleResolution + '.json');
    await writeFile(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: moduleResolution === 'node' ? 'CommonJS' : 'NodeNext', moduleResolution, strict: true, skipLibCheck: true, esModuleInterop: true, noEmit: true, types: [] }, files: ['./consumer.ts'] }, null, 2) + '\n');
    const trace = run(tsc, ['-p', config, '--traceResolution'], consumer);
    assert.ok(trace.includes(path.join('dist', 'src', 'index.d.ts')), moduleResolution + ' must resolve the emitted declarations');
    assert.ok(!trace.includes(path.join('src', 'index.ts')), moduleResolution + ' must not resolve the TypeScript source');
  }
  assert.ok(packed.files.some((file) => file.path === 'NOTICE'));
  console.log('Package smoke passed: pack -> offline install -> ESM import -> CLI demo -> scaffold -> offline npm ci -> validate/demo/harness suite');
} finally { await rm(temp, { recursive: true, force: true }); }

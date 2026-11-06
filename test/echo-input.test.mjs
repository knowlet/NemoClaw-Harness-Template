/** UNOFFICIAL regression tests for bounded UTF-8 starter input. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { renderNativeHarness } from '../src/index.mjs';

const limit = 1048576;
const sources = [
  ['standalone echo', await readFile(new URL('../examples/echo/agent.mjs', import.meta.url), 'utf8')],
  ['native echo', renderNativeHarness({ name: 'utf8-test' })],
];

async function echo(source, chunks) {
  let stdout = '';
  // Use the actual example/generated source with controlled stream chunks.
  // OS pipe writes can coalesce, so they cannot guarantee a split code point.
  const input = Readable.from(chunks);
  const body = source.replace(/^#![^\n]*\n/, '');
  try {
    await runInNewContext(`(async () => {\n${body}\n})()`, {
      Buffer,
      process: {
        argv: ['node', 'harness.mjs'],
        stdin: input,
        stdout: { write: (chunk) => { stdout += chunk; } },
      },
    });
  } catch (error) {
    assert.equal(stdout, '', 'rejected input must not emit a partial echo');
    throw error;
  } finally { input.destroy(); }
  return stdout;
}

for (const [name, source] of sources) {
  test(`${name} preserves UTF-8 at every byte boundary`, async () => {
    const task = '繁體中文 café 🦖';
    const bytes = Buffer.from(task);
    for (let split = 1; split < bytes.length; split++) {
      assert.equal(await echo(source, [bytes.subarray(0, split), bytes.subarray(split)]), `Echo: ${task}\n`, `split ${split}`);
    }
    assert.equal(await echo(source, Array.from(bytes, (byte) => Buffer.from([byte]))), `Echo: ${task}\n`);
  });

  test(`${name} preserves empty and ASCII input`, async () => {
    assert.equal(await echo(source, []), 'Echo: \n');
    assert.equal(await echo(source, [Buffer.from('hello'), Buffer.from(' world')]), 'Echo: hello world\n');
  });

  test(`${name} accepts exactly 1 MiB across a multibyte split`, async () => {
    const task = 'a'.repeat(limit - 4) + '🦖';
    const bytes = Buffer.from(task);
    assert.equal(bytes.length, limit);
    assert.equal(await echo(source, [bytes.subarray(0, limit - 2), bytes.subarray(limit - 2)]), `Echo: ${task}\n`);
  });

  test(`${name} rejects raw input above 1 MiB`, async () => {
    await assert.rejects(echo(source, [Buffer.alloc(limit, 0x61), Buffer.from('x')]), /Task exceeds 1 MiB/);
    await assert.rejects(echo(source, [Buffer.from('🦖'.repeat(limit / 4 + 1))]), /Task exceeds 1 MiB/);
  });
}

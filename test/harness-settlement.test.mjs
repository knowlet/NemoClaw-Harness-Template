import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdapter, runHarness } from '../src/index.mjs';

// Real POSIX descendants can start a separate session and retain inherited
// output pipes after the harness process group is killed. These controlled
// fixtures have a safety lifetime and are explicitly terminated below.
for (const mode of ['timeout', 'abort', 'output']) {
  test(`${mode} settles when a detached descendant retains output pipes`, { skip: process.platform === 'win32' }, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nha-settlement-'));
    const ready = path.join(dir, 'descendant.json');
    let descendant;
    let watchdog;
    let invocation;
    t.after(async () => {
      clearTimeout(watchdog);
      if (!descendant) {
        try { descendant = JSON.parse(await readFile(ready, 'utf8')); } catch { /* Fixture did not start. */ }
      }
      if (descendant) {
        try { process.kill(-descendant.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
      }
      if (invocation) await invocation;
      await rm(dir, { recursive: true, force: true });
    });
    const escaped = `
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }));
      setTimeout(() => process.exit(0), 10000);
    `;
    const launcher = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], {
        detached: true, stdio: ['ignore', 1, 2]
      }).unref();
      if (${JSON.stringify(mode)} === 'output') {
        const wait = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(ready)})) {
            clearInterval(wait);
            process.stdout.write('fixture-output'.repeat(100));
          }
        }, 5);
      }
      setInterval(() => {}, 1000);
    `;
    const adapter = structuredClone(createAdapter('settlement-fixture', 'fixture'));
    adapter.runtime.command = [process.execPath, '-e', launcher];
    adapter.runtime.timeoutMs = mode === 'timeout' ? 2500 : 10000;
    adapter.runtime.maxOutputBytes = mode === 'output' ? 64 : 4096;
    const controller = new AbortController();
    invocation = runHarness(adapter, 'fixture', { cwd: dir, home: dir, signal: controller.signal })
      .then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (error) => error);
    for (let i = 0; i < 200; i += 1) {
      try { descendant = JSON.parse(await readFile(ready, 'utf8')); break; } catch { await delay(10); }
    }
    assert.ok(descendant?.pid, 'detached descendant must be running before the failure');
    if (mode === 'abort') controller.abort();
    const result = await Promise.race([
      invocation,
      new Promise((resolve) => { watchdog = setTimeout(() => resolve({ code: 'STILL_PENDING' }), 5000); }),
    ]);
    clearTimeout(watchdog);
    assert.equal(result.code, { timeout: 'TIMEOUT', abort: 'ABORTED', output: 'OUTPUT_LIMIT' }[mode]);
    assert.ok(!result.message.includes('fixture-output'), 'failure must not expose output');
    // Settlement is not a claim to contain or kill a different process group.
    assert.doesNotThrow(() => process.kill(descendant.pid, 0));
  });
}

// UNOFFICIAL optional interoperability smoke. Requires Python 3 and Go; missing tools FAIL, not skip.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdapter, runSuite, SUITE_VERSION } from '../src/index.mjs';
const temp = await mkdtemp(path.join(os.tmpdir(), 'harness-frameworks-'));
try {
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 5000 }).trim();
  execFileSync('go', ['version'], { timeout: 5000 });
  await writeFile(path.join(temp, 'echo.py'), 'import sys\nsys.stdout.write("Echo: " + sys.stdin.read() + "\\n")\n');
  await writeFile(path.join(temp, 'echo.go'), 'package main\nimport("fmt";"io";"os")\nfunc main(){b,e:=io.ReadAll(os.Stdin);if e!=nil{os.Exit(1)};fmt.Printf("Echo: %s\\n",b)}\n');
  execFileSync('go', ['build', '-o', path.join(temp, 'go-echo'), path.join(temp, 'echo.go')], {
    timeout: 120000, env: { ...process.env, CGO_ENABLED: '0', GO111MODULE: 'off', GOPROXY: 'off' },
  });
  const tasks = ['hello', '繁體中文 🦖', '$(touch NOT_CREATED); "quotes"', 'first\nsecond'];
  const cases = tasks.map((task, i) => ({ name: `input-${i + 1}`, task, expect: { stdout: `Echo: ${task}\n` } }));
  for (const [name, command] of [['python', [python, path.join(temp, 'echo.py')]], ['go', [path.join(temp, 'go-echo')]]]) {
    const workspace = path.join(temp, name); await mkdir(workspace);
    const adapter = structuredClone(createAdapter(`${name}-fixture`));
    adapter.runtime.command = command;
    const report = await runSuite({ version: SUITE_VERSION, name: `${name}-interoperability`, cases }, { adapter, cwd: workspace, home: workspace });
    assert.equal(report.ok, true, JSON.stringify(report));
    console.log(JSON.stringify(report));
  }
} finally { await rm(temp, { recursive: true, force: true }); }

// TypeScript source of truth; declarations are emitted by tsc.
// @ts-nocheck
/** UNOFFICIAL OpenShell headless lifecycle: create a persistent sandbox, then explicitly exec a task. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AdapterError, buildOpenShellCommand } from './sdk.js';

export function buildOpenShellPlan(options) {
  const legacy = buildOpenShellCommand(options); // Reuse all input and image validations.
  const separator = legacy.indexOf('--');
  return {
    create: [...legacy.slice(0, separator), '--detach', '--no-tty', '--no-auto-providers', '--', '/usr/bin/sleep', 'infinity'],
    ready: ['openshell', 'sandbox', 'exec', '--name', options.name, '--', '/usr/bin/true'],
    execute: ['openshell', 'sandbox', 'exec', '--name', options.name, '--', ...legacy.slice(separator + 1)],
  };
}

function command(argv, { quiet = false, timeoutMs, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new AdapterError('ABORTED', 'OpenShell operation cancelled'));
  return new Promise((resolve, reject) => {
    let stopped = false;
    const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: quiet ? 'ignore' : 'inherit' });
    const abort = () => { stopped = true; child.kill('SIGKILL'); };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); reject(new AdapterError('OPENSHELL_UNAVAILABLE', 'Cannot execute the OpenShell CLI')); });
    child.once('close', (code) => {
      cleanup();
      if (signal?.aborted) reject(new AdapterError('ABORTED', 'OpenShell operation cancelled'));
      else if (stopped) reject(new AdapterError('TIMEOUT', 'OpenShell operation exceeded its deadline'));
      else resolve(code ?? 1);
    });
  });
}

/** A failed task is a failed launch; creation alone never counts as task success. */
export async function launchOpenShell(options, { signal } = {}) {
  const plan = buildOpenShellPlan(options);
  if (await command(plan.create, { timeoutMs: 120000, signal }) !== 0) {
    throw new AdapterError('SANDBOX_CREATE_FAILED', 'OpenShell sandbox creation failed');
  }
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    try { ready = await command(plan.ready, { quiet: true, timeoutMs: 5000, signal }) === 0; }
    catch (e) { if (e.code !== 'TIMEOUT') throw e; }
    if (ready) break;
    try { await delay(1000, undefined, { signal }); }
    catch { throw new AdapterError('ABORTED', 'OpenShell operation cancelled'); }
  }
  if (!ready) throw new AdapterError('SANDBOX_NOT_READY', 'Sandbox did not become executable; inspect or delete the partially created sandbox');
  if (await command(plan.execute, { timeoutMs: 3600000, signal }) !== 0) {
    throw new AdapterError('SANDBOX_TASK_FAILED', 'Harness task failed inside the sandbox');
  }
  // The idle sandbox remains available for more exec calls. Removal is explicit.
  return { name: options.name, taskSucceeded: true };
}

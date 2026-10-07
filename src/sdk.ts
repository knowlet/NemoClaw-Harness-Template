// TypeScript source of truth; declarations are emitted by tsc.
/** Independent, UNOFFICIAL harness adapter SDK. Not an NVIDIA extension API. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AdapterManifest, RunOptions, RunResult, InferenceOptions, ChatMessage, ChatOptions, ChatResponse, ChatUsage, OpenShellOptions,
} from './types.js';

export const VERSION = '0.3.0' as const;
export const API_VERSION = 'harness-adapter.knowlet.dev/v1alpha1' as const;
export const INFERENCE_URL = 'https://inference.local/v1' as const;
export const PLACEHOLDER_TOKEN = 'openshell' as const;
export const NOTICE = 'UNOFFICIAL / 非官方: independent community SDK; not affiliated with, endorsed by, or supported by NVIDIA or DeepSeek.';

export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}
function fail(message: string): never { throw new AdapterError('INVALID_MANIFEST', message); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
function keys(value: unknown, allowed: readonly string[], label: string) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(`Invalid or unknown fields in ${label}`);
}
function integer(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${label}`);
}
function statePath(value: unknown): value is string {
  return text(value) && value.startsWith('/sandbox/') && /^[A-Za-z0-9_./-]+$/.test(value) && path.posix.normalize(value) === value && !value.endsWith('/');
}
function relativePath(value: unknown): value is string {
  return text(value) && !path.posix.isAbsolute(value) && !value.includes('\\') && value !== '.' && !value.split('/').includes('..') && path.posix.normalize(value) === value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const CONFIG_ENV = /^(DSH_HOME|DSH_TELEMETRY_DISABLED|LANG|LC_ALL|NHA_CUSTOM_[A-Z0-9_]+)$/;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/;

/** Validate and defensively copy a data-only manifest. Commands are trusted executable input. */
export function defineAdapter(input: AdapterManifest): Readonly<AdapterManifest> {
  keys(input, ['apiVersion', 'kind', 'metadata', 'runtime', 'inference', 'state', 'env'], 'manifest');
  if (input.apiVersion !== API_VERSION || input.kind !== 'HarnessAdapter') fail('Unsupported adapter schema');
  keys(input.metadata, ['name', 'displayName', 'unofficial'], 'metadata');
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.metadata.name ?? '')) fail('Invalid adapter name');
  if (!text(input.metadata.displayName, 128) || input.metadata.unofficial !== true) fail('An explicit unofficial identity is required');
  keys(input.runtime, ['command', 'taskInput', 'timeoutMs', 'maxOutputBytes'], 'runtime');
  const { command, taskInput, timeoutMs, maxOutputBytes } = input.runtime;
  if (!Array.isArray(command) || command.length < 1 || command.length > 64 || !command.every((arg) => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0')) || !text(command[0]) || !path.posix.isAbsolute(command[0])) fail('command must be an argv array with an absolute executable');
  if (!['stdin', 'argv'].includes(taskInput)) fail('taskInput must be stdin or argv');
  integer(timeoutMs, 1, 3600000, 'timeoutMs');
  integer(maxOutputBytes, 1, 16777216, 'maxOutputBytes');
  keys(input.inference, ['baseUrl', 'model'], 'inference');
  if (input.inference.baseUrl !== INFERENCE_URL) fail('Managed inference must use https://inference.local/v1');
  if (!text(input.inference.model, 256) || /[\r\n]/.test(input.inference.model)) fail('Invalid model');
  keys(input.state, ['home', 'workspace', 'persist', 'reconstruct', 'prohibit'], 'state');
  if (!statePath(input.state.home) || !statePath(input.state.workspace)) fail('State and workspace must be normalized paths under /sandbox');
  const { home, workspace } = input.state;
  if (home === workspace || home.startsWith(`${workspace}/`) || workspace.startsWith(`${home}/`)) fail('Home and workspace must not overlap');
  const all: string[] = [];
  for (const group of ['persist', 'reconstruct', 'prohibit'] as const) {
    const paths = input.state[group];
    if (!Array.isArray(paths) || paths.length > 64 || !paths.every(relativePath)) fail(`Invalid state.${group}`);
    all.push(...paths);
  }
  if (new Set(all).size !== all.length || all.some((a, i) => all.some((b, j) => i !== j && b.startsWith(`${a}/`)))) fail('State classifications must not overlap');
  keys(input.env ?? {}, Object.keys(input.env ?? {}), 'env');
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!CONFIG_ENV.test(key) || SECRET_NAME.test(key) || !text(value)) fail('Environment field is not permitted');
  }
  if (input.env?.DSH_HOME && input.env.DSH_HOME !== home) fail('DSH_HOME must match state.home');
  return freeze(JSON.parse(JSON.stringify(input)) as AdapterManifest);
}

export function createAdapter(name = 'my-harness', model = 'managed-model') {
  return defineAdapter({
    apiVersion: API_VERSION, kind: 'HarnessAdapter',
    metadata: { name, displayName: name, unofficial: true },
    runtime: { command: ['/usr/local/bin/node', '/opt/nha/agent.mjs'], taskInput: 'stdin', timeoutMs: 120000, maxOutputBytes: 1048576 },
    inference: { baseUrl: INFERENCE_URL, model },
    state: { home: '/sandbox/.harness', workspace: '/sandbox/workspace', persist: ['sessions'], reconstruct: ['cache'], prohibit: ['settings.yaml', '.credentials.yaml', 'plugins', 'profiles', 'cordis.patch.yml'] },
    env: {},
  });
}

export async function loadAdapter(filename: string): Promise<Readonly<AdapterManifest>> {
  const data = await readFile(filename);
  if (data.length > 65536) fail('Manifest exceeds 64 KiB');
  try { return defineAdapter(JSON.parse(data.toString('utf8'))); }
  catch (error) { if (error instanceof AdapterError) throw error; fail('Manifest is not valid JSON'); }
}

/** Check immutable configuration, not sandbox attestation. POSIX only. */
export async function assertManagedFile(filename: string): Promise<Readonly<AdapterManifest>> {
  if (process.platform === 'win32') throw new AdapterError('UNSUPPORTED_PLATFORM', 'Managed launch requires Linux/POSIX');
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new AdapterError('UNTRUSTED_CONFIG', 'Managed configuration and ancestors must be root-owned, non-symlink, and not group/other-writable');
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o222) !== 0 || stat.size > 65536) throw new AdapterError('UNTRUSTED_CONFIG', 'Managed configuration must be a read-only regular file <=64 KiB');
    return defineAdapter(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
}

/** Only sandbox transport/trust variables survive; never forward ambient provider keys or loader hooks. */
export function buildEnvironment(adapter: AdapterManifest, parent: Record<string, string | undefined> = process.env, home = adapter.state.home): Record<string, string> {
  adapter = defineAdapter(adapter);
  const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (typeof parent[key] === 'string') env[key] = parent[key];
  }
  Object.assign(env, adapter.env, {
    HOME: home, NHA_MODEL: adapter.inference.model, NHA_INFERENCE_BASE_URL: INFERENCE_URL,
    NHA_INFERENCE_TOKEN: PLACEHOLDER_TOKEN, NODE_USE_ENV_PROXY: '1',
  });
  return env;
}

/** Execute a trusted harness command. This function DOES NOT create a sandbox. */
export async function runHarness(input: AdapterManifest, task: string, options: RunOptions = {}): Promise<RunResult> {
  const adapter = defineAdapter(input);
  if (!text(task, 1048576) || Buffer.byteLength(task) > 1048576) throw new AdapterError('INVALID_TASK', 'Task must be a non-empty string <=1 MiB without NUL');
  if (adapter.runtime.taskInput === 'argv' && (task.startsWith('-') || Buffer.byteLength(task) > 16384)) throw new AdapterError('INVALID_TASK', 'argv tasks must not start with a dash and must fit in 16 KiB; use stdin for arbitrary input');
  if (options.signal?.aborted) throw new AdapterError('ABORTED', 'Harness invocation aborted');
  const argv = [...adapter.runtime.command];
  if (adapter.runtime.taskInput === 'argv') argv.push(task);
  const started = performance.now();
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd ?? adapter.state.workspace,
      env: buildEnvironment(adapter, options.parentEnv ?? process.env, options.home ?? adapter.state.home),
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
    });
    let failure: AdapterError | undefined;
    let size = 0;
    let settled = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const kill = () => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already reaped. */ }
    };
    const stop = (code: string, message: string) => { failure ??= new AdapterError(code, message); kill(); };
    const abort = () => stop('ABORTED', 'Harness invocation aborted');
    const timer = setTimeout(() => stop('TIMEOUT', 'Harness exceeded its execution deadline'), adapter.runtime.timeoutMs);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > adapter.runtime.maxOutputBytes) stop('OUTPUT_LIMIT', 'Harness exceeded its combined stdout/stderr limit');
      else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop('STDIN_FAILED', 'Cannot deliver task to harness'); });
    child.once('error', () => {
      if (settled) return;
      settled = true; cleanup(); kill();
      reject(new AdapterError('SPAWN_FAILED', 'Cannot start harness; check executable, permissions, and workspace'));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup(); kill();
      if (failure) reject(failure);
      else if (code !== 0) reject(new AdapterError('PROCESS_FAILED', `Harness exited unsuccessfully (${code ?? signal})`));
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: 0, durationMs: Math.round(performance.now() - started) });
    });
    child.stdin.end(adapter.runtime.taskInput === 'stdin' ? task : undefined);
  });
}

function inferenceEndpoint(baseUrl: string, development: boolean) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new AdapterError('INVALID_ENDPOINT', 'Invalid inference endpoint'); }
  if (url.username || url.password || url.search || url.hash) throw new AdapterError('INVALID_ENDPOINT', 'Credentials, query strings, and fragments are forbidden in inference URLs');
  if (baseUrl === INFERENCE_URL) return baseUrl;
  if (development && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && url.pathname === '/v1') return baseUrl;
  throw new AdapterError('INVALID_ENDPOINT', 'Only managed inference, or explicit loopback HTTP development, is permitted');
}

function isChatMessage(value: unknown): value is ChatMessage {
  return record(value)
    && typeof value.role === 'string'
    && ['system', 'developer', 'user', 'assistant', 'tool'].includes(value.role)
    && (value.tool_calls === undefined || Array.isArray(value.tool_calls))
    && (value.tool_call_id === undefined || typeof value.tool_call_id === 'string');
}

/** Normalize only nullable wire detail containers; keep the public object-only usage contract. */
function normalizeNullableUsageDetails(value: unknown): void {
  if (!record(value) || !record(value.usage)) return;
  // Providers such as vLLM serialize an unavailable breakdown as null. The
  // response is freshly parsed JSON: omit just those fields before validation,
  // without coercing counters, dropping invalid siblings, or walking metadata.
  for (const key of ['prompt_tokens_details', 'completion_tokens_details']) {
    if (value.usage[key] === null) delete value.usage[key];
  }
}

/** Known scalar usage counters must be finite numbers; detail objects and other extensions stay opaque. */
function isChatUsage(value: unknown): value is ChatUsage {
  if (!record(value)) return false;
  return ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((key) =>
    value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key])))
    && ['prompt_tokens_details', 'completion_tokens_details'].every((key) =>
      value[key] === undefined || record(value[key]));
}

/** Validate the declared response contract while retaining opaque content and extension fields. */
function isChatResponse(value: unknown): value is ChatResponse {
  if (!record(value) || !Array.isArray(value.choices) || value.choices.length === 0) return false;
  if (!value.choices.every((choice: unknown) => record(choice)
    && isChatMessage(choice.message)
    && (choice.finish_reason === undefined || choice.finish_reason === null || typeof choice.finish_reason === 'string')
    && (choice.index === undefined || (typeof choice.index === 'number' && Number.isFinite(choice.index))))) return false;
  return value.usage === undefined || isChatUsage(value.usage);
}

/** Bounded, non-streaming Chat Completions client. No upstream API key is accepted. */
export function createInferenceClient({ model, baseUrl = INFERENCE_URL, development = false, timeoutMs = 120000, maxResponseBytes = 8388608 }: Partial<InferenceOptions> = {}) {
  if (!text(model, 256)) throw new AdapterError('INVALID_MODEL', 'A model is required');
  integer(timeoutMs, 1, 3600000, 'timeoutMs');
  integer(maxResponseBytes, 1, 16777216, 'maxResponseBytes');
  const endpoint = inferenceEndpoint(baseUrl, development);
  return Object.freeze({
    async chat(messages: ChatMessage[], { signal, ...parameters }: ChatOptions = {}): Promise<ChatResponse> {
      if (!Array.isArray(messages) || messages.length === 0 || !messages.every((message) => record(message) && ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role))) throw new AdapterError('INVALID_MESSAGES', 'A non-empty messages array with valid roles is required');
      if (Object.keys(parameters).some((key) => !['temperature', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'response_format', 'seed', 'top_p'].includes(key))) throw new AdapterError('INVALID_PARAMETERS', 'Unsupported inference parameter; streaming and credential overrides are not accepted');
      const body = JSON.stringify({ ...parameters, model, messages, stream: false });
      if (Buffer.byteLength(body) > 1048576) throw new AdapterError('REQUEST_LIMIT', 'Inference request exceeds 1 MiB');
      if (signal?.aborted) throw new AdapterError('ABORTED', 'Inference request aborted');
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER_TOKEN}` }, body,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new AdapterError('HTTP_ERROR', `Inference returned HTTP ${response.status}; response body intentionally omitted`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new AdapterError('INVALID_RESPONSE', 'Inference response has no body');
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > maxResponseBytes) { await reader.cancel(); throw new AdapterError('RESPONSE_LIMIT', 'Inference response exceeds its configured limit'); }
          chunks.push(Buffer.from(value));
        }
        let result: unknown;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new AdapterError('INVALID_RESPONSE', 'Inference returned invalid JSON'); }
        normalizeNullableUsageDetails(result);
        if (!isChatResponse(result)) throw new AdapterError('INVALID_RESPONSE', 'Inference did not return a valid Chat Completions response');
        return result;
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        if (timedOut) throw new AdapterError('TIMEOUT', 'Inference deadline exceeded');
        if (signal?.aborted) throw new AdapterError('ABORTED', 'Inference request aborted');
        throw new AdapterError('TRANSPORT_FAILED', 'Inference transport failed; check managed routing, proxy, and CA trust');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  });
}

export function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function assertImageDigest(image: string): string {
  if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new AdapterError('UNPINNED_IMAGE', 'Use an OCI image@sha256:<64 lowercase hex> reference');
  return image;
}

/** Pure argv construction; does not provision a gateway or create an inference route. */
export function buildOpenShellCommand({ name, image, policy, task, allowMutableImage = false }: OpenShellOptions): string[] {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name ?? '')) throw new AdapterError('INVALID_NAME', 'Invalid sandbox name');
  if (allowMutableImage) {
    if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9._:/@-]+$/.test(image)) throw new AdapterError('INVALID_IMAGE', 'Invalid development image reference');
  } else assertImageDigest(image);
  if (!text(policy) || policy.startsWith('-') || /[\r\n]/.test(policy)) throw new AdapterError('INVALID_POLICY', 'A policy path is required');
  if (!text(task, 16384) || Buffer.byteLength(task) > 16384) throw new AdapterError('INVALID_TASK', 'A task is required and must fit in 16 KiB');
  return ['openshell', 'sandbox', 'create', '--name', name, '--from', image, '--policy', path.resolve(policy), '--', '/usr/local/bin/node', '/opt/nha/bin/nha.mjs', 'exec', '/etc/nha/adapter.json', '--managed', '--task', task];
}

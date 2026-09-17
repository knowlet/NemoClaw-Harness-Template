# SDK reference — UNOFFICIAL community contract

Package: `@knowlet/nemoclaw-harness-sdk@0.1.0`. ESM only; TypeScript declarations ship with the package. This is not an NVIDIA SDK, and this package is not claimed to be published to npm. Install its `npm pack` tarball as described in the [README](../README.md).

## Adapter schema

`createAdapter(name?, model?)` creates a validated, deeply frozen starter. Use `structuredClone()` to edit it and `defineAdapter()` to validate the result. `loadAdapter(path)` parses a JSON file; `assertManagedFile(path)` additionally checks POSIX ownership, ancestry, symlinks, and read-only mode. Unknown versions and fields are rejected. Model names must be supplied by the operator, not discovered or guessed by the SDK.

| Field | Contract |
| --- | --- |
| `apiVersion` | Exactly `harness-adapter.knowlet.dev/v1alpha1` |
| `kind` | Exactly `HarnessAdapter` |
| `metadata` | Lowercase hyphenated `name`, `displayName`, mandatory `unofficial: true` |
| `runtime.command` | Non-empty argv array; absolute executable; no implicit shell |
| `runtime.taskInput` | `stdin` recommended, or `argv` appended as one argument |
| `runtime.timeoutMs` | Integer, 1 to 3,600,000 |
| `runtime.maxOutputBytes` | Integer, 1 to 16,777,216; stdout and stderr combined |
| `inference.baseUrl` | Exactly `https://inference.local/v1` |
| `inference.model` | Non-empty model ID, up to 256 characters |
| `state.home`, `state.workspace` | Normalized, disjoint paths below `/sandbox`; restricted safe path characters |
| `state.persist`, `reconstruct`, `prohibit` | Non-overlapping relative-path declarations; no snapshot engine is implemented |
| `env` | Optional `LANG`, `LC_ALL`, `DSH_HOME`, `DSH_TELEMETRY_DISABLED`, or `NHA_CUSTOM_*` configuration values; secret-like names rejected |

The schema contains executable identity and is **trusted operator input**, not a document to accept directly from an LLM or untrusted repository. The validator does not make `command: ['/bin/sh', '-c', ...]` safe: it prevents implicit shell interpolation, not deliberate execution of a shell by the operator.

## Process runner

```js
const result = await runHarness(adapter, task, {
  cwd: '/sandbox/workspace',
  home: '/sandbox/.harness',
  signal: abortController.signal,
});
```

The returned promise resolves only on exit code 0, with `{ stdout, stderr, exitCode: 0, durationMs }`. It rejects with `AdapterError` and a stable `code` for failure. Successful output is application data and is **not PII-redacted**. Failure messages omit child stdout/stderr and do not echo tasks, arguments, or raw provider responses.

Tasks are limited to 1 MiB. `argv` additionally limits tasks to 16 KiB and refuses a leading dash, to prevent a task being parsed as an option by common CLIs. Prefer stdin for arbitrary input. UTF-8 byte limits apply. On POSIX the runner kills its process group on timeout, abort, output overflow, or completion; detached/escaped processes still require sandbox controls. Windows lacks equivalent process-group containment in this SDK and is not a managed target.

Environment propagation uses an allowlist, not ambient inheritance. Upstream API keys, cloud tokens, `NODE_OPTIONS`, and `LD_PRELOAD` are not forwarded. Trusted proxy and CA variables survive, alongside fixed `HOME`, `PATH`, model configuration, `NODE_USE_ENV_PROXY=1`, and the public inference placeholder. This is **not a general secret detector**; review allowed configuration values and proxy credentials yourself.

`runHarness()` does not establish a sandbox or call `assertManagedFile()`. Those checks belong to the CLI managed entry or your embedding application. `parentEnv`, `cwd`, and `home` are operator-controlled options, not user prompt parameters.

## Inference client

```js
const client = createInferenceClient({
  model: 'your-managed-model',
  timeoutMs: 120000,
  maxResponseBytes: 8 * 1024 * 1024,
});
const response = await client.chat(
  [{ role: 'user', content: 'Describe this workspace' }],
  { temperature: 0, max_tokens: 512, signal: abortController.signal },
);
```

Only `POST /v1/chat/completions` is implemented. Requests are capped at 1 MiB; responses are bounded while being read, with the deadline covering the body as well as headers. Redirects are not followed. No automatic retries are performed, avoiding unexpected duplicate cost. HTTP error bodies are intentionally suppressed.

Supported options: `temperature`, `max_tokens`, `max_completion_tokens`, `tools`, `tool_choice`, `response_format`, `seed`, `top_p`, and `signal`. The configured provider/model must actually support any optional parameter. Unknown parameters, `stream`, custom headers, model overrides, and API-key overrides are rejected. Tool calls are returned to the application; no tools are executed automatically.

For deterministic local tests only:

```js
const client = createInferenceClient({
  model: 'fixture-model',
  baseUrl: 'http://127.0.0.1:8080/v1',
  development: true,
});
```

Development exceptions are limited to HTTP loopback hostnames with the `/v1` path. There is no arbitrary external provider escape hatch. For managed clients set proxy/CA environment before starting Node. The managed CLI requires Node 24.5+ to cover built-in HTTP and fetch proxy handling. We do not disable TLS verification.

## Generators and deployment

`scaffold(newDirectory, { name, model })` bundles the SDK, echo example, CLI, declarations, notices, image recipe, and policy into a new project; it refuses an existing destination. It does not install dependencies, run a harness, build an image, or create a gateway. If interrupted during the final copy, inspect and remove the partial directory before retrying.

`renderPolicy(adapter)` returns a full OpenShell BYOC policy baseline. `renderDockerfile(adapter)` expects the **generated project** as build context, not the repository root. `renderDeepSeekPatch(adapter)` is an experimental Cordis configuration fragment; it is not a complete security policy, capability roster, or official integration.

`buildOpenShellCommand({ name, image, policy, task, allowMutableImage? })` returns an argv array, never a shell string. By default it requires a digest reference. It does not contact a registry or verify signatures. The command uses the fixed managed entry paths supplied by the generated image.

`digest(value)` hashes a string or `JSON.stringify(value)` with SHA-256. It is useful for matching a particular serialized configuration, but it is **not canonical JSON hashing** and is not a signature or attestation.

## CLI

| Command | Effect |
| --- | --- |
| `nha demo` | Deterministic echo on the local host; no sandbox/model |
| `nha init DIR --name NAME --model MODEL` | Create a self-contained starter project |
| `nha validate adapter.json` | Validate our schema, without launching code |
| `nha render adapter.json --output NEW_DIR` | Render build-input fragments; not a complete build context |
| `nha exec adapter.json --managed --task TEXT` | Require immutable root-owned config, non-root process, and Node 24.5+, then run |
| `nha exec adapter.json --allow-host --task-file FILE` | Explicitly run reviewed executable code on the host with a warning |
| `nha plan --name NAME --image IMAGE --policy FILE --task TEXT` | Output exact OpenShell argv, no external mutation |
| `nha launch ...` | Execute that OpenShell command; creates a sandbox |
| `nha doctor` | Check local binaries/version; not a compatibility or health certification |

`--managed` and `--allow-host` are mutually exclusive, as are `--task` and `--task-file`. Use `node bin/nha.mjs` from a source checkout, or `nha` after installing the package into a project with its local bin on PATH. Do not send secrets in task arguments: OS process listings may expose argv. The headless DSH upstream surface requires argv; that limitation is documented in its candidate.

## Errors and stability

Relevant codes include `INVALID_MANIFEST`, `UNTRUSTED_CONFIG`, `INVALID_TASK`, `SPAWN_FAILED`, `PROCESS_FAILED`, `TIMEOUT`, `ABORTED`, `OUTPUT_LIMIT`, `INVALID_ENDPOINT`, `INVALID_PARAMETERS`, `HTTP_ERROR`, `RESPONSE_LIMIT`, `INVALID_RESPONSE`, `TRANSPORT_FAILED`, and `UNPINNED_IMAGE`.

This is a `0.x` community SDK with an explicitly alpha adapter schema. Pin the package version. Unknown schema versions fail closed; automatic migration is not implemented. Upstream NemoClaw/OpenShell/DeepSeek compatibility is separately recorded in [architecture](ARCHITECTURE.md), not guaranteed by our package version.

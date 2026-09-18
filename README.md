# NemoClaw Harness Adapter Template — UNOFFICIAL

**Independent community project by knowlet. Not an official NVIDIA SDK. Not affiliated with, endorsed by, certified by, or supported by NVIDIA or DeepSeek.**

[繁體中文](README.zh-TW.md) · [SDK reference](docs/SDK.md) · [Architecture / compatibility](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [DeepSeek candidate](examples/deepseek/README.md)

Package a harness so the **NemoClaw CLI onboards it itself**. `nha native init` and `nha native install` write the `agents/<name>/` directory that the NemoClaw CLI scans, so `nemoclaw onboard --agent <name>` builds the image, creates the sandbox, and runs your harness inside it. Start with the **[native quickstart](docs/QUICKSTART.md)**.

Two integrations ship here, and they are different:

| Path | What it does | Use it when |
| --- | --- | --- |
| **Native agent packaging** (`nha native`) | Writes `agents/<name>/` into a NemoClaw source checkout at one pinned revision, so NemoClaw's own onboarding manages the runtime | You want `nemoclaw onboard --agent <name>` to work |
| **Standalone SDK + OpenShell BYOC** (`adapter.json`) | Generates an independent SDK, image recipe, and policy, and plans or launches an OpenShell sandbox for you | You want to hand OpenShell an image yourself, or only use the SDK and process runner |

`adapter.json` is an independent, versioned community schema, not NVIDIA's `manifest.yaml`, and it registers nothing with NemoClaw. The native path does register an agent, but only against the pinned revision it targets: that `agents/` layout is not a published NVIDIA extension API. See the upstream [extension decision](https://github.com/NVIDIA/NemoClaw/blob/eb10bf0b93f36968c841c96f58b081bc1301c485/docs/reference/extension-taxonomy-sdk-readiness.mdx).

## Quickstart: onboard your harness

```bash
git clone -b develop https://github.com/knowlet/NemoClaw-Harness-Template.git
cd NemoClaw-Harness-Template
npm ci --ignore-scripts
npm run build
node scripts/quickstart.mjs --workdir /tmp/nha-quickstart
```

That runner does the whole tutorial on a clean machine and prints every command: it builds the pinned NemoClaw CLI, installs the checksum-pinned OpenShell, creates and installs the agent package, onboards it, and runs the harness inside the sandbox. It ends with `QUICKSTART OK`. No model or API key is needed — a deterministic local fixture stands in.

Success looks like `loaderAccepted: true` from `native verify`, `✓ <Your Agent> terminal runtime is ready` at the end of onboarding, and `Echo: NHA_NATIVE_OK` from the harness inside the sandbox.

The same steps, explained one at a time with a troubleshooting section, are in the **[native quickstart guide](docs/QUICKSTART.md)**. Native packaging details and its limits are in the [native packaging guide](docs/NATIVE.md).

## Local SDK only (no Docker, no model)

Use Node.js 22.16+ for the SDK and local tests. Managed image launch deliberately requires Node.js 24.5+ and Linux/POSIX. The managed route and sandbox need separate configuration.

```bash
git clone -b develop https://github.com/knowlet/NemoClaw-Harness-Template.git
cd NemoClaw-Harness-Template
npm ci --ignore-scripts
npm run check
npm run demo
node bin/nha.mjs init ./my-harness --name my-harness
cd my-harness
npm run validate
npm test
printf 'hello' | node agent.mjs
```

The output is `Echo: hello`. **The demo is a real local process test, but it is not an LLM and does not run in a sandbox.** It intentionally needs no API key or external network.

The generated project contains:

```text
my-harness/
├── adapter.json           # Community schema; rejects unknown versions/fields
├── agent.mjs              # Replace the deterministic echo with your harness
├── Dockerfile             # Explicit base image, non-root runtime, immutable config
├── policy.yaml            # OpenShell BYOC baseline; no extra egress allowance
├── src/                   # Self-contained SDK and TypeScript declarations
├── bin/nha.mjs            # init / validate / render / exec / plan / launch / doctor
├── package.json
├── package-lock.json
├── LICENSE
└── NOTICE
```

## Install the SDK in another project

The package name is **`@knowlet/nemoclaw-harness-sdk`**, version `0.3.0`. **No npm registry publication is implied.** Build the installable tarball from this checkout:

```bash
npm run pack:sdk
# Install from this checkout using a stable, neutral filename:
npm install ./dist/harness-sdk.tgz
```

The tarball includes the CLI, templates, examples, declarations, and notices. CI tests an offline install in an empty consumer and then scaffolds another working project from the installed CLI.

```js
import { createAdapter, defineAdapter, runHarness } from '@knowlet/nemoclaw-harness-sdk';

const input = structuredClone(createAdapter('my-go-harness', 'your-managed-model'));
input.runtime.command = ['/opt/my-harness/bin/agent'];
input.runtime.taskInput = 'stdin';
const adapter = defineAdapter(input);

// Call INSIDE an already established sandbox. This function only spawns a process.
const result = await runHarness(adapter, 'Inspect the workspace');
console.log(result.stdout);
```

No source-language rewrite is required. A Python equivalent uses `['/usr/bin/python3', '/opt/my-harness/agent.py']`; install the runtime and dependencies in the image at build time. The SDK does not download or install them on first launch.

## Reusable harness test suite

Generated projects include `test/suite.json` and `test/harness.test.mjs`; run `npm test`, then replace the command and case oracles for your framework. The SDK exports `runSuite`, `defineSuite`, `toJUnit`, and a loopback inference fixture through `/testing`. JSON/JUnit reports omit task/output bodies.

```bash
node bin/nha.mjs test test/suite.json --adapter adapter.local.json \
  --allow-host --json result.json --junit result.xml
```

The adapter must point to an existing local executable; `--allow-host` is explicit, unsandboxed execution. See [test-kit guide](docs/TESTING.md) for managed execution and custom framework bridges. Actual NemoClaw/Docker deployment has a separate [runtime workflow](.github/workflows/runtime-integration.yml), not a mocked CLI. Its passed/failed outcomes are recorded separately from SDK tests.

## Managed inference

```js
import { createInferenceClient } from '@knowlet/nemoclaw-harness-sdk';

const client = createInferenceClient({ model: 'your-managed-model' });
const response = await client.chat([{ role: 'user', content: 'Return exactly OK' }]);
console.log(response.choices[0].message.content);
```

The client uses `https://inference.local/v1/chat/completions` and the **non-secret placeholder** `openshell`, not a provider API key. A compatible gateway must already route that endpoint and hold the provider credentials. No provider is created, attached, or reconfigured by this SDK. `managed-model` in the starter is a placeholder, not a claimed model offering.

The client supports bounded **non-streaming Chat Completions**, including passing tool schemas and returning tool calls. It is not a tool executor, agent loop, Responses API client, or streaming SDK. An explicit loopback-only development mode is available for local mock servers. See [SDK reference](docs/SDK.md).

## Advanced: build and launch an OpenShell BYOC candidate

From a generated project:

```bash
# Development only: mutable base and apt repositories are not a release provenance lock.
docker build --build-arg BASE_IMAGE=node:24-bookworm-slim -t my-harness:dev .

# Preview the exact argv; no sandbox is created by plan.
node bin/nha.mjs plan --name my-harness --image my-harness:dev \
  --dev-image --policy policy.yaml --task hello

# Explicit side effect: creates a sandbox via your installed OpenShell CLI.
node bin/nha.mjs launch --name my-harness --image my-harness:dev \
  --dev-image --policy policy.yaml --task hello
```

Prerequisites: a compatible OpenShell gateway, a container engine matching its driver, an image the gateway can access, and kernel support for the policy. For LLM tasks, additionally provision the managed inference route outside this SDK. A remote gateway cannot use an image existing only in your local engine.

Without `--dev-image`, `plan` and `launch` reject images that are not `image@sha256:<digest>`. This verifies **reference syntax**, not the image's contents, authenticity, availability, or SBOM. Use reviewed base and runtime digests and record dependency provenance before release. Do not substitute a Docker success for OpenShell policy qualification.

OpenShell replaces OCI `ENTRYPOINT`; the planner explicitly supplies the process after `--`, as required by the upstream [BYOC contract](https://github.com/NVIDIA/OpenShell/blob/c502be9fd73c41bab25f0a88587b7a3d90c96b55/examples/bring-your-own-container/README.md).

## Advanced: native packaging details

The BYOC path above hands an image to OpenShell yourself. The native path instead writes the
`agents/<name>/` directory that the NemoClaw CLI scans during onboarding, so
`nemoclaw onboard --agent <name>` manages the runtime.

```bash
node bin/nha.mjs native init ./my-harness --name my-harness --model your-managed-model
node bin/nha.mjs native install ./my-harness --nemoclaw ../NemoClaw
node bin/nha.mjs native verify --nemoclaw ../NemoClaw --name my-harness
```

The generated package contains `manifest.yaml`, `policy-additions.yaml`, `Dockerfile`,
`start.sh`, `harness.mjs`, `dependency-review.md`, and `native-agent.json`. NemoClaw builds
that Dockerfile itself on the Docker driver and enforces the generated deny-by-default policy.

`native verify` runs the real compiled loader from the checkout and reports `listed`,
`loaderAccepted`, and the resolved Dockerfile. It always reports `deploymentVerified: false`:
loader acceptance is not a deployment. A real deployment — image build, sandbox creation, and task
execution inside the sandbox — is recorded by the runtime workflow, not inferred by this command.

Native packaging targets one pinned upstream revision,
`NVIDIA/NemoClaw@1eb370f20530bd1312ac86a27782ef8501b28ade`, and that `agents/` layout is internal
to the revision rather than a public NVIDIA extension API. See the
[native packaging guide](docs/NATIVE.md).

## What is implemented, and what is not

| Surface | Status |
| --- | --- |
| SDK import, process runner, local demo, scaffold, CLI, packed installation | Locally tested |
| Manifest validation, env filtering, deadlines, cancellation, output bounds | Locally tested; defense in depth, not sandbox isolation |
| Inference wire handling and failure cases | Tested against local HTTP fixtures; no live model claim |
| OCI build inputs and OpenShell command generation | Generated and structurally tested; needs live deployment qualification |
| DeepSeek headless integration | **Experimental**, source-reviewed, no bundled DSH runtime or live E2E qualification |
| Native `agents/<name>/` packaging for one pinned NemoClaw revision | Generated, with loader acceptance and workload selection verified against the real checkout |
| Other NemoClaw-managed operations (snapshots, recovery, lifecycle verbs) | **Not implemented; no public extension compatibility promise** |
| Web UI authentication, streaming, snapshot/restore, automatic policy approval | Not implemented |

State `persist`, `reconstruct`, and `prohibit` entries are **validated declarations**, not an implemented backup engine. Filesystem/network enforcement belongs to OpenShell. An untrusted executable can bypass this SDK from inside its sandbox; do not treat our launcher as the outer security boundary.

## Development

```bash
npm run check        # Syntax/JSON/docs lint + runtime tests + packed-install smoke
npm run doctor       # Reports local tools; does not claim a sandbox is qualified
# With TypeScript installed:
tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 test/types.mts
```

The dependency-free linter checks syntax, JSON, whitespace, relative documentation links, and unofficial notices; it is not ESLint. The GitHub workflow pins action revisions and checks Node 22.16 and Node 24. See [validation record](docs/VALIDATION.md) for actual execution evidence and remaining limitations.

## License and names

Our SDK and templates use [MIT](LICENSE). Third-party harnesses retain their own licenses and are not bundled. No NVIDIA logos are used. Keep the [NOTICE](NOTICE) when redistributing this template and do not imply official certification or support.

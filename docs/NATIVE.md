# Native NemoClaw agent packaging (UNOFFICIAL)

This SDK can write a **NemoClaw-native agent package**: the `agents/<name>/` directory layout that
the NemoClaw CLI scans during onboarding. It is a second, additive path next to the OpenShell BYOC
template; the BYOC flow is unchanged.

> **UNOFFICIAL / 非官方** — independent community project. Not an official NVIDIA SDK, and not
> affiliated with, endorsed by, or supported by NVIDIA. NemoClaw, OpenShell, and DeepSeek are
> third-party projects with their own licenses.

## What "native" means here

NemoClaw resolves `--agent <name>` by scanning `<checkout>/agents` for directories that contain a
`manifest.yaml`. Dropping a package into that directory is the upstream registration step. There is
no plugin API and no runtime registration call.

This layout is **internal to a pinned upstream revision**, not a public extension point. Native
packaging therefore records the revision it targets:

    NVIDIA/NemoClaw@1eb370f20530bd1312ac86a27782ef8501b28ade

The SDK reads the checkout Git `HEAD` before install or verify and requires this exact revision. Other revisions may rename, add, or reject fields; use the explicit compatibility qualification path before changing the pin.

## Commands

    # 1. Build a native agent package. Nothing is published.
    node bin/nha.mjs native init ./my-harness --name my-harness --model your-model

    # 2. Install it into a NemoClaw source checkout you control.
    node bin/nha.mjs native install ./my-harness --nemoclaw ../NemoClaw

    # 3. Ask the real loader whether it accepts the agent.
    node bin/nha.mjs native verify --nemoclaw ../NemoClaw --name my-harness

    # 4. Onboard with the real NemoClaw CLI.
    node ../NemoClaw/bin/nemoclaw.js onboard --agent my-harness --name my-sandbox

`native install` and `native verify` fail with `UNSUPPORTED_UPSTREAM` when the checkout Git `HEAD` is not `NATIVE_CONTRACT.revision`. The CLI accepts `--allow-unsupported-upstream` only as an explicit escape hatch for a compatibility qualification run; it records the actual checkout revision in its JSON result.

## Upstream compatibility qualification

Use the compatibility runner to compare more than one NemoClaw checkout with the same generated package and loader probe:

    npm run compatibility -- \
      --checkout pinned=../NemoClaw-pinned \
      --checkout main=../NemoClaw-main \
      --build \
      --json reports/nemoclaw-compatibility.json

The report records each checkout's actual Git revision, whether it matches the pinned contract, and separate `scaffold`, `install`, `loader`, `gateway`, `preflight`, `onboard`, `exec`, and `cleanup` stages. `--deploy` adds real onboarding and one deterministic sandbox task; it also requires a working OpenShell installation and the documented provider environment. Deploy cases receive per-run sandbox names that satisfy NemoClaw's routed-name contract, which caps a name at 19 characters and rejects consecutive hyphens, so the run token keeps the name unique when the prefix does not fit. Each case probes its name before onboarding and cleans up only after claiming ownership. Use `--sandbox-token` when a CI job needs reproducible names. Failure categories distinguish `contract`, `infrastructure`, and `product` problems. Candidate revisions are intentionally allowed inside this runner so compatibility can be measured; normal SDK install and verify commands remain pinned by default.

The runner never starts a gateway, so a deploy run needs one already running. Add `--gateway nemoclaw` to bind every case to that name: the runner selects it, requires its status to report a live connection, and passes the same name to `sandbox get` and `sandbox delete`, so a case cannot probe one gateway and delete from another. Without the flag the probe and cleanup follow whatever gateway happens to be selected. Start the managed gateway through the pinned NemoClaw checkout before qualifying; the [compatibility workflow](../.github/workflows/upstream-compatibility.yml) shows that bootstrap.

The package contains `manifest.yaml`, `policy-additions.yaml`, `Dockerfile`, `start.sh`, `launcher.sh`,
`harness.mjs`, `harness.test.mjs`, `dependency-review.md`, and `native-agent.json`.

Those seven files — manifest, policy, Dockerfile, start script, harness, harness test, and launcher — are `NATIVE_REQUIRED_FILES`. Every command validates that each one exists **as a regular file**, so a missing or replaced entry fails before anything is installed instead of during the image build.

`native-agent.json` records a `packVersion`, and the required set is versioned: version 2 needs all seven files above, while a version 1 package (generated before the harness test existed) stays installable without it, so upgrading the SDK does not invalidate a package you already have. An unknown version is refused.

The validator also requires the parts to agree with each other: the manifest must declare the agent named in the metadata, the Dockerfile must build from the package directory `agents/<name>`, and any recorded upstream contract must be the revision this SDK targets.

Those agreement checks tolerate equivalent spellings: the top-level manifest name is read through optional quotes and a trailing comment, and the Dockerfile only has to reference `agents/<name>` on a line that is not a comment (a trailing slash or a different destination is fine, while a lookalike such as `agents/<name>-extra` is not). A version 2 package must record the upstream contract; a version 1 package may omit it, because the validator that produced it never required the field.

### Installing and replacing

`native install` is staged, not destructive:

- The package is copied into a staging directory under `agents/` and re-validated there.
- Only then is the previous directory moved aside and the staged package renamed into place.
- If the swap fails, the previous package is restored. If it cannot be restored, it is preserved and its path is reported.
- Nothing installed is ever deleted before a complete replacement exists on disk.

`--replace` only overwrites a directory this SDK installed (one that carries `native-agent.json`). A hand-written agent, or one shipped by NemoClaw, is refused with `NOT_SDK_PACKAGE` rather than silently deleted. Installing a package over itself is refused with `SAME_PATH` and changes nothing.

## What each command proves, and what it does not

`native verify` runs the **real compiled loader** from the checkout you pass and reports what it
found:

- `listed` — the agent appears in the loader's agent list.
- `loaderAccepted` — `loadAgent` returned a definition and workload selection resolved to this
  agent's own Dockerfile through the supported `legacy-dockerfile` path.
- `deploymentVerified` — always `false` from `verify`. Loader acceptance is not deployment.

To claim a deployment you need an actual run: onboarding builds the image and creates the sandbox,
then you execute the agent inside it. That is what the runtime integration workflow does, and it
records the outcome in `reports/` instead of inferring it.

## How NemoClaw consumes the package

- The agent is not one of the shipped managed images, so workload selection falls back to the
  **legacy Dockerfile** path: NemoClaw builds `agents/<name>/Dockerfile` on the Docker driver.
- NemoClaw stages the **checkout root** as the Docker build context, so the generated Dockerfile
  uses repository-relative `COPY agents/<name>/...` sources.
- `policy-additions.yaml` is mandatory for a non-OpenClaw agent. NemoClaw refuses to substitute the
  OpenClaw baseline policy when it is missing or unreadable.
- The image declares `ENTRYPOINT /usr/local/bin/nemoclaw-start`, which keeps the sandbox alive so
  tasks run through explicit `exec` calls. The manifest's `runtime.headless_command` is the
  harness entrypoint.
- `launcher.sh` installs to `/usr/local/bin/<name>` and is declared as the manifest
  `binary_path`. NemoClaw terminal-agent setup requires an executable at that path; without it the
  onboarding step fails after the sandbox is already running.

## Security properties of the generated package

- The base image is `node:24-bookworm-slim`. The image installs only `ca-certificates`, `iproute2`, and
  `nftables`, which the OpenShell sandbox supervisor requires for its network namespace; the runtime
  payload itself is one dependency-free script.
- The sandbox user is created with a fixed uid/gid (999, matching the shipped terminal agents).
  Agent paths under `/sandbox` are owner-only.
- The policy is deny by default: read-only system paths, writable `/sandbox` and `/tmp`, and a
  single managed `inference.local` route limited to `/v1/chat/completions` and `/v1/models`.
- The generated configuration contains no credentials. NemoClaw supplies the managed route
  credential to the running agent; an upstream provider key never enters the sandbox.

## Limitations

- One pinned upstream revision. The checkout must be a Git repository at that exact commit. This is a source-checkout integration, not a stable extension API.
- The generator emits a deterministic echo starter, not an LLM. Replace `harness.mjs` (and
  `runtime.headless_command`) with your runtime, then re-verify.
- `native install` refuses to overwrite an existing agent unless you pass `--replace`, and it replaces only directories this SDK installed.
- Agent names are checked against a reserved list: `node` and `nemoclaw-start` would overwrite the interpreter and the entrypoint, and `openclaw`, `hermes`, `pi`, `nemocua`, and `langchain-deepagents-code` already own a directory under `agents/`.
- `native verify` fails with `TIMEOUT` when the loader probe exceeds its deadline, and bounds the probe output.
- The SDK never publishes, uploads, or pulls images, and it never registers anything with NVIDIA.

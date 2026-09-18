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

Other revisions may rename, add, or reject fields. Re-verify after any upstream change.

## Commands

    # 1. Build a native agent package. Nothing is published.
    node bin/nha.mjs native init ./my-harness --name my-harness --model your-model

    # 2. Install it into a NemoClaw source checkout you control.
    node bin/nha.mjs native install ./my-harness --nemoclaw ../NemoClaw

    # 3. Ask the real loader whether it accepts the agent.
    node bin/nha.mjs native verify --nemoclaw ../NemoClaw --name my-harness

    # 4. Onboard with the real NemoClaw CLI.
    node ../NemoClaw/bin/nemoclaw.js onboard --agent my-harness --name my-sandbox

The package contains `manifest.yaml`, `policy-additions.yaml`, `Dockerfile`, `start.sh`, `launcher.sh`,
`harness.mjs`, `dependency-review.md`, and `native-agent.json`.

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

- One pinned upstream revision. This is a source-checkout integration, not a stable extension API.
- The generator emits a deterministic echo starter, not an LLM. Replace `harness.mjs` (and
  `runtime.headless_command`) with your runtime, then re-verify.
- `native install` refuses to overwrite an existing agent unless you pass `--replace`.
- The SDK never publishes, uploads, or pulls images, and it never registers anything with NVIDIA.

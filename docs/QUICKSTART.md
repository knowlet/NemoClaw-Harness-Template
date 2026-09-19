# Native quickstart — UNOFFICIAL

Get **your own harness** onboarded by NemoClaw so that `nemoclaw onboard --agent <name>` builds the
image, creates the sandbox, and runs your harness inside it.

> **UNOFFICIAL / 非官方** — independent community project. Not an official NVIDIA SDK, and not
> affiliated with, endorsed by, or supported by NVIDIA. NemoClaw and OpenShell are third-party
> projects under their own licenses.

## Prerequisites

- Linux (`x86_64` or `aarch64`) with a working Docker daemon
- Node.js 22.16 or newer (24 is what this path is validated on)
- `git` and `curl`
- About 15 minutes and roughly 4 GB of free disk for the NemoClaw checkout and the images
- **No model or API key is needed to prove the path.** A deterministic local fixture stands in for
  inference, and the starter harness does not call a model.

## Run it in one command

```bash
git clone -b develop https://github.com/knowlet/NemoClaw-Harness-Template.git
cd NemoClaw-Harness-Template
npm ci --ignore-scripts
npm run build
node scripts/quickstart.mjs --workdir /tmp/nha-quickstart
```

That runner performs the whole tutorial in order and prints every command as it goes:

1. checks Node, Docker, and git (and builds this SDK from TypeScript if `dist/` is absent)
2. clones `NVIDIA/NemoClaw` and checks out `1eb370f20530bd1312ac86a27782ef8501b28ade`, then runs
   `npm ci`, `npm --prefix nemoclaw ci`, and `npm run build:cli`
3. installs the checksum-pinned OpenShell CLI, gateway, and sandbox through NemoClaw's own installer
4. creates the agent package and installs it into that checkout
5. asks the real NemoClaw loader whether it accepts the agent
6. onboards the agent and runs the harness inside the resulting sandbox

It runs the package test before installing, and it prints `QUICKSTART OK` only when the deploy succeeded and the cleanup you asked for also succeeded. Add `--destroy` to delete the sandbox at the end, `--customize` to change the payload and redeploy it, `--name` and `--sandbox` to pick different names, or `--dry-run` to see the steps without running them.

## The same steps, one at a time

Use this path if you want to see each step, or if something needs debugging.

Put both repositories in one work directory so every path below is unambiguous. These commands are written to run from `~/nha-work/NemoClaw-Harness-Template`, with the NemoClaw checkout beside it.

```bash
mkdir -p ~/nha-work && cd ~/nha-work
git clone https://github.com/NVIDIA/NemoClaw.git
git clone -b develop https://github.com/knowlet/NemoClaw-Harness-Template.git
```

### 1. Build the NemoClaw CLI at the pinned revision

```bash
cd ~/nha-work/NemoClaw
git checkout 1eb370f20530bd1312ac86a27782ef8501b28ade
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix nemoclaw ci --ignore-scripts --no-audit --no-fund
npm run build:cli
node bin/nemoclaw.js --version
```

NemoClaw's agent layout is not a published extension API, so this packaging targets exactly that
revision. Keep the checkout you build and the CLI you run the same one.

### 2. Install the checksum-pinned OpenShell

```bash
NEMOCLAW_NON_INTERACTIVE=1 bash scripts/install-openshell.sh
export PATH="$HOME/.local/bin:$PATH"
openshell --version
```

Onboarding needs `openshell` **and** its `openshell-gateway` and `openshell-sandbox` siblings in the
same directory. This installer fetches all three and verifies NVIDIA's published digests; doing it
by hand from a single tarball leaves onboarding stuck later.

### 3. Create your agent package and install it

```bash
cd ../NemoClaw-Harness-Template
node bin/nha.mjs native init ./my-harness --name my-harness --model your-managed-model
node bin/nha.mjs native install ./my-harness --nemoclaw ../NemoClaw
node --test my-harness/harness.test.mjs
node bin/nha.mjs native install ./my-harness --nemoclaw ../NemoClaw
node bin/nha.mjs native verify --nemoclaw ../NemoClaw --name my-harness
```

`--test` runs the test that ships inside the package, and `native install` copies your package into the checkout.

`native verify` runs the checkout's real loader and prints `loaderAccepted: true` when NemoClaw resolves
your agent and selects its Dockerfile. It always prints `deploymentVerified: false` — loader
acceptance is not a deployment.

### 4. Onboard it

With your own OpenAI-compatible endpoint:

```bash
export NEMOCLAW_PROVIDER=custom
export NEMOCLAW_MODEL=your-managed-model
export NEMOCLAW_PROVIDER_KEY=your-key
export NEMOCLAW_ENDPOINT_URL=https://your-endpoint.example/v1
node ../NemoClaw/bin/nemoclaw.js onboard --agent my-harness --name my-sandbox   --no-gpu --no-sandbox-gpu --non-interactive --yes --yes-i-accept-third-party-software
```

Or, to prove the path with no model at all, run the bundled deterministic fixture in another shell
and point onboarding at it:

```bash
node scripts/integration/fixture-provider.mjs &
export NEMOCLAW_PROVIDER=custom NEMOCLAW_MODEL=fixture-model \
  NEMOCLAW_PROVIDER_KEY=fixture-only-not-a-secret \
  NEMOCLAW_ENDPOINT_URL=http://host.openshell.internal:18080/v1
node ../NemoClaw/bin/nemoclaw.js onboard --agent my-harness --name my-sandbox   --no-gpu --no-sandbox-gpu --non-interactive --yes --yes-i-accept-third-party-software
```

The first run builds an image and takes a few minutes.

### 5. Run your harness inside the sandbox

```bash
node ../NemoClaw/bin/nemoclaw.js my-sandbox exec -- /usr/local/bin/my-harness NHA_NATIVE_OK
```

## What success looks like

- `native verify` prints `loaderAccepted: true`.
- Onboarding ends with `✓ <Your Agent> terminal runtime is ready`.
- `nemoclaw list` shows your sandbox with `agent: my-harness`.
- The exec above prints `Echo: NHA_NATIVE_OK` — the starter harness runs inside the real sandbox.

The starter is a deterministic echo, not an LLM. That is deliberate: it proves the packaging,
image build, sandbox, and policy without mixing in model quality.

## Make it your harness

Your package lives in one place: the directory `native init` created (`my-harness/` in the work directory above). **That is the source you edit.** `native install` copies it into the NemoClaw checkout at `agents/my-harness/`, so the copy inside the checkout is installed output — editing it there is overwritten by the next install.

What is in the package:

- `harness.mjs` is the payload. Replace it with your entrypoint, or keep it and shell out to your runtime.
- `manifest.yaml` declares `runtime.headless_command` (how tasks are invoked) and `binary_path` (an executable NemoClaw checks during setup). Keep the launcher at `/usr/local/bin/<name>` pointing at your runtime.
- `policy-additions.yaml` is deny-by-default. Add the endpoints your harness actually needs, and nothing more.
- `Dockerfile` installs your dependencies. NemoClaw stages the checkout as the build context, so reference files as `agents/<name>/...`.
- `harness.test.mjs` is the package test. It runs on the host with `node --test` and never needs to run inside the image. Keep it passing as you change the payload; the quickstart runner runs it before every install.

The whole loop, in the order that keeps you from deploying a stale image:

```bash
# 1. edit my-harness/harness.mjs, and keep harness.test.mjs in step with it
node --test my-harness/harness.test.mjs
node bin/nha.mjs native install ./my-harness --nemoclaw ../NemoClaw --replace
node ../NemoClaw/bin/nemoclaw.js my-sandbox destroy --yes --force
node ../NemoClaw/bin/nemoclaw.js onboard --agent my-harness --name my-sandbox \
  --no-gpu --no-sandbox-gpu --non-interactive --yes --yes-i-accept-third-party-software --fresh
node ../NemoClaw/bin/nemoclaw.js my-sandbox exec -- /usr/local/bin/my-harness your-task
```

Destroying the sandbox before re-onboarding is not optional: NemoClaw keeps the running sandbox and its image, so skipping it leaves the previous payload in place.

`node scripts/quickstart.mjs --customize` runs exactly this loop, and fails unless the redeployed sandbox returns the **new** output. That is how this section is checked in CI rather than trusted.

`--replace` only overwrites directories this SDK installed. A hand-written or vendor-provided agent directory is refused on purpose.

## Troubleshooting

**"System readiness could not confirm required capabilities: gateway.reuse.ready"** — OpenShell is
missing or incomplete. Run step 2 and confirm `openshell --version` works.

**"openshell ... is missing Docker-driver binaries"** — you installed only the CLI tarball. Run
NemoClaw's `scripts/install-openshell.sh`, which installs the gateway and sandbox together.

**"The gateway port is held by an incompatible or ambiguous owner" / "gateway.version.compatible"** — a
gateway from an earlier attempt is still listening on 8080, often because the OpenShell binaries were
reinstalled since. Find it with `ss -ltnp | grep :8080` (NemoClaw prints the equivalent `lsof` line) and
stop only that matching process, then retry. Never stop a gateway another project is using.
**"Onboarding cannot use retained sandbox '<name>'"** — an earlier attempt left a recovery record.
Destroy it (`nemoclaw <name> destroy --yes --force`) or onboard under a different `--name`.

**Unknown agent 'my-harness'** — the agent is installed in a different checkout than the CLI you
ran. Install into, and onboard from, the same NemoClaw checkout.

**Agent name is reserved** — `node`, `nemoclaw-start`, and the shipped agent names
(`openclaw`, `hermes`, `pi`, `nemocua`, `langchain-deepagents-code`) are refused because they
collide with runtime paths or upstream directories.

**The image build fails on `COPY agents/<name>/launcher.sh`** — the package is incomplete. Re-run
`native init`, or `native install` again: every required file is validated before install.

## Cleanup

```bash
node ../NemoClaw/bin/nemoclaw.js my-sandbox destroy --yes --force
docker image ls | grep nemoclaw-sandbox-local
```

Remove the work directory and the NemoClaw checkout when you are done; nothing else is left behind.

If the runner reports a cleanup failure it prints the command output and exits nonzero. Absence is only accepted from a message that names this sandbox and says it is gone, so an unrecognised phrasing is reported as a failure rather than quietly counted as success.

## What is verified, and by whom

The [runtime integration workflow](../.github/workflows/runtime-integration.yml) and the
[quickstart workflow](../.github/workflows/quickstart.yml) run these steps on a fresh GitHub runner.
The quickstart job is native-only: it never onboards OpenClaw first, so it proves this path works
from a clean environment on its own. The concrete outcomes of both runs are recorded in the
[validation record](VALIDATION.md).

# Validation record — UNOFFICIAL

Date: 2026-09-18. Evidence is scoped to the exact check, not NVIDIA certification.

## SDK v0.3.0

Local environment: Linux aarch64, Node 24.18.0, npm 11.16.0.

| Check | Actual result |
| --- | --- |
| `npm run check` | Passed, including lint, **99 tests (0 failed, 0 skipped)**, and packed installation |
| TypeScript strict declarations, including `/testing` | Passed |
| Packed clean offline install | Passed: ESM root and `/testing` imports, CLI, scaffold, generated offline install and `npm test` |
| Neutral SDK artifact path | `npm run pack:sdk` writes `dist/harness-sdk.tgz`; README lint rejects maintainer-prefixed artifact paths |

Tests cover versioned manifests/suites, process argv/stdin, output limits, timeout/cancellation, expected-error oracles, sanitized JSON/JUnit reports, real loopback HTTP fixtures with tool calls, and exclusive report/scaffold writes. These are not isolation attestation.

## Actual runtime attempts

The local container has no Docker daemon, so deployment is executed on a real GitHub-hosted Ubuntu 24.04 Docker runner. The workflow builds NVIDIA/NemoClaw source at `1eb370f20530bd1312ac86a27782ef8501b28ade` and uses checksum-verified OpenShell `v0.0.116`.

The upstream model is a **deterministic HTTP fixture**, not an LLM. No production provider key is used. The real components are the NemoClaw CLI, OpenShell gateway/supervisor, Docker engine, images, sandbox, and network/policy machinery.

| Run | Actual result |
| --- | --- |
| [35187333111](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35187333111) | Real CLI build and OpenShell install passed; deployment failed because `gateway start` is not supported by the pinned CLI |
| [35187691124](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35187691124) | NemoClaw started a real gateway, built an OpenClaw image, created a Ready sandbox, and started its agent gateway. Onboarding then **failed** its managed inference smoke with HTTP 503; later integration steps were skipped |

The second run used a loopback host fixture URL. Run [35192120630](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35192120630) on commit 0db274d then passed every real step: pinned CLI build, OpenShell v0.0.116 install, NemoClaw onboarding, OpenShell BYOC sandbox execution, and the harness suite inside the NemoClaw-managed sandbox. A committed workflow is not evidence that it passed. `continue-on-error` permits independent diagnostics only; the final job requires all three checks to pass.

Each new run uploads `runtime-evidence` with exact commit/version metadata and check outcomes. Consult the actual run before claiming a successful deployment. See [runtime workflow](../.github/workflows/runtime-integration.yml).

## Native agent packaging

A pinned NVIDIA/NemoClaw checkout was built locally (aarch64) with its own npm ci and build:cli; node bin/nemoclaw.js --version reports nemoclaw v0.1.0. Against that build:

| Check | Actual result |
| --- | --- |
| nha native install into the checkout | Passed: agents/native-echo/ written |
| nha native verify against the real loader | Passed: listed true, loaderAccepted true, workload legacy-dockerfile with reason agent-not-managed |
| nemoclaw onboard --help on the same checkout | Lists the generated agent under --agent |
| Generated policy-additions.yaml against schemas/sandbox-policy.schema.json | Valid (draft 2020-12, with the referenced network-policy.schema.json) |
| Real nemoclaw onboard --agent native-echo | **Passed** with the same checksum-pinned OpenShell 0.0.116 gateway/sandbox binaries: the image built, the sandbox reached Ready, and onboarding reported "Native Echo terminal runtime is ready" |
| nemoclaw list | Shows the sandbox with agent: native-echo |
| Execution inside the sandbox | /usr/local/bin/native-echo NHA_NATIVE_OK returns Echo: NHA_NATIVE_OK; the declared smoke command returns NEMO_SMOKE_OK |

Two real defects surfaced only in this end-to-end run and are fixed in the generator: the image lacked iproute2/nftables, which the OpenShell supervisor needs to build its network namespace, and the manifest declared no binary_path, which NemoClaw terminal-agent setup requires. Earlier attempts failed on each in turn. Deployment evidence is also recorded by the CI workflow below.

Runtime integration run [35326474616](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35326474616) on commit `c3af650` passed every recorded check on a GitHub-hosted Ubuntu 24.04 Docker runner (`cli`, `native_loader`, `onboard`, `native`, `byoc`, `embedded` all `success`). That run builds the pinned NemoClaw CLI, installs checksum-verified OpenShell 0.0.116, verifies the generated agent against the real loader, onboards it, executes the harness inside the sandbox, and then runs the OpenShell BYOC path.

## Limits

No real-model quality benchmark, DeepSeek runtime boot, dual-architecture qualification, GPU inference, or lifecycle/snapshot/restore test is claimed. Native packaging registers one agent for one pinned NemoClaw revision; other NemoClaw-managed operations (snapshots, recovery, lifecycle verbs) remain unimplemented. Filesystem and egress security are established only for explicit assertions that actually passed, not by an SDK status flag.

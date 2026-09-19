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

The quickstart runner (scripts/quickstart.mjs) then completed in reuse mode against that checkout on aarch64: preflight, OpenShell install, native init/install/verify, real onboarding, and in-sandbox execution all succeeded, ending in QUICKSTART OK with the sandbox deleted afterwards. A first attempt failed on a stale gateway process from an earlier run still holding port 8080; that case is now in the quickstart troubleshooting section.

Run [35332873049](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35332873049) on commit 748f446 is the clean-room proof: on a fresh Ubuntu 24.04 runner, with a fail-fast check that no NemoClaw state existed, the documented quickstart built agents/my-harness, onboarding reported "my-harness terminal runtime is ready", the sandbox returned "Echo: NHA_NATIVE_OK", and the sandbox was deleted. SDK checks [35332873027](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35332873027) and runtime integration [35332873019](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35332873019) passed for the same commit.

Runtime integration run [35326474616](https://github.com/knowlet/NemoClaw-Harness-Template/actions/runs/35326474616) on commit `c3af650` passed every recorded check on a GitHub-hosted Ubuntu 24.04 Docker runner (`cli`, `native_loader`, `onboard`, `native`, `byoc`, `embedded` all `success`). That run builds the pinned NemoClaw CLI, installs checksum-verified OpenShell 0.0.116, verifies the generated agent against the real loader, onboards it, executes the harness inside the sandbox, and then runs the OpenShell BYOC path.

## Native packaging review round

A review pass over commit `7f4f0b1` reported defects in the native packaging code. Each was reproduced locally before the fix and re-checked after it:

| Defect | Before | After |
| --- | --- | --- |
| `--replace` deleted the installed package before the replacement existed | Installing a package over its own installed directory returned ENOENT and destroyed the package, including local edits; a mid-copy failure lost the previous package | The replacement is staged and re-validated, then swapped in; same-path and overlapping paths are refused with `SAME_PATH`, and a failed copy leaves the previous package intact |
| `readNativePackage` did not require `launcher.sh` | A package missing the launcher passed validation and install, then failed the image build | One shared `NATIVE_REQUIRED_FILES` list drives generator and validator, and every entry must be a regular file |
| Agent names could collide with runtime paths | `node` and `nemoclaw-start` were accepted and would overwrite the interpreter and entrypoint | A reserved-name list is refused in both the generator and the package validator |
| `--replace` could delete a shipped upstream agent | Installing a package named `openclaw` replaced NVIDIA's own agent directory | Replacement is refused unless the existing directory carries this SDK's `native-agent.json` (`NOT_SDK_PACKAGE`) |
| `--json FILE` was parsed as a boolean flag | The filename became a stray positional and the report was never written | `--json` takes a value and writes the report |
| Timeout was reported as a generic failure | A probe deadline produced `VERIFY_FAILED` with an exit of `null` | A deadline reports `TIMEOUT`, probe output is bounded, and stderr is drained so the probe cannot block on a full pipe |
| The starter hijacked the literal task `smoke` | A real task whose text was exactly `smoke` returned the smoke sentinel | The sentinel is `--smoke` |

Regression tests cover each case, including a staging-directory check and a foreign-agent-directory check.

## Native packaging: customization, cleanup, and artifact tests

A review of `45b0a68` asked for a tested customization loop, cleanup that cannot report success after failing, and tests that ship with the artifact. This branch adds all three.

| Gap | What changed | Evidence |
| --- | --- | --- |
| Editing the harness was described against the checkout copy while the reinstall read the package directory | The quickstart guide now states that the package directory is the only source you edit and that `agents/<name>/` inside the checkout is installed output, and it gives the loop in order: edit, test, `install --replace`, destroy, re-onboard | The guide leads the section with the rule instead of the file list |
| Customization was never exercised, so a stale image could look like success | `--customize` changes the payload, keeps the package test passing, reinstalls, destroys, redeploys, and requires the sandbox to return the new output | Local aarch64 run finished with "V2 Echo: NHA_NATIVE_V2" and QUICKSTART OK; an unmodified payload would have returned the V1 string |
| `--destroy` used `allowFailure` and never checked the exit code, and ran only on the success path | The destroy result is checked, an already-absent sandbox is treated as clean, a real failure fails the run, and cleanup now runs in `finally` so a failed deploy cannot leave a retained sandbox | A run with a deliberate failure in the customization step still deleted the sandbox before reporting the error |
| The generated package shipped no test | It now ships `harness.test.mjs`, listed in `NATIVE_REQUIRED_FILES`, and the runner executes it before installing | `npm test` includes a regression that runs the generated test; the suite is 108 tests |

The SDK and CLI sources on this branch are TypeScript: `npm run check` typechecks the implementation, builds `dist/`, and the package consumer imports the compiled layout. TypeScript and Node types are development-only, so the runtime stays dependency-free. `strict` is deliberately still off so language migration and type hardening stay separate changes.

## TypeScript migration: package compatibility fixes

A review of `89b3bc7` raised three issues outside the green CI gates. All three were reproduced independently, including by a separate verification agent, and are fixed here.

| Issue | Root cause | Fix | Evidence |
| --- | --- | --- | --- |
| The top-level `types` field still pointed at `./src/index.d.ts`, which the migration deleted | The migration moved `exports.types` but left the legacy field. Classic node10 resolution ignores `exports`, follows the dangling field, strips the missing `.d.ts` and falls through to the TypeScript source | The field points at `./dist/src/index.d.ts`, and the packed-consumer test compiles a strict consumer under both `node` and `NodeNext`, asserting the resolution target is the emitted declaration and never the source | Before: node10 exit 2 with 82 source-level errors. After: exit 0, resolving `dist/src/index.d.ts` |
| `--destroy` treated any output containing "not found" as a deleted sandbox | The absence check matched a generic phrase against the whole combined output rather than a sandbox-scoped message | Absence requires a line naming the sandbox being deleted plus an explicit absence phrase, in `scripts/lib/sandbox-cleanup.mjs` with unit tests | `OpenShell gateway not found; cannot delete sandbox my-sandbox`, and a bridge-provider warning followed by a permission error, both reported success before and both fail now |
| Adding the harness test to the required files broke packages generated by the previous revision | The required set changed without a version bump, so a `packVersion: 1` package failed a file-existence check | `NATIVE_PACK_VERSION` is 2 and the required set is versioned, with the v1 six-file layout still accepted; unknown versions are refused | A v1 fixture the old validator accepted was rejected with `missing harness.test.mjs`; it installs again |

Two validation gaps the same review thread raised in `src/native.ts` were also still open, so they are closed here: a package whose metadata names one agent while its manifest or Dockerfile belongs to another is refused, and a package recording a different upstream revision is refused.

Local verification: `npm run check` passes with 118 tests, and the packed-consumer smoke compiles the strict classic-resolution consumer.

## Limits

No real-model quality benchmark, DeepSeek runtime boot, dual-architecture qualification, GPU inference, or lifecycle/snapshot/restore test is claimed. Native packaging registers one agent for one pinned NemoClaw revision; other NemoClaw-managed operations (snapshots, recovery, lifecycle verbs) remain unimplemented. Filesystem and egress security are established only for explicit assertions that actually passed, not by an SDK status flag.

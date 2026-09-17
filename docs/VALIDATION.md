# Initial validation record — UNOFFICIAL

Date: 2026-09-17. This records SDK validation, not NVIDIA/OpenShell/DeepSeek qualification.

Local environment: Linux x86_64, Node.js 22.16.0, npm 10.9.2. No Docker, Podman, nerdctl, OpenShell gateway, provider credentials, or live model was available. Network-independent tests use local processes and loopback HTTP fixtures.

Actual local results:

| Check | Result |
| --- | --- |
| `npm run lint` | Passed: 24 source/doc files checked |
| `npm test` | **60 passed, 0 failed, 0 skipped** |
| `npm run test:package` | Passed: pack, clean offline install, ESM import, CLI demo, installed scaffold, offline npm ci, validate/demo |
| TypeScript 5.8.3 strict declaration check | Passed |
| `nha doctor` | Correctly reported no local container/OpenShell tools and `liveSandboxVerified: false` |

 The GitHub workflow is separate: a committed workflow is not evidence that its jobs have passed. Consult the actual Actions run for the delivered commit.

Covered checks: manifest rejection and immutability, process argv/stdin handling, environment filtering, deadline/cancellation/output bounds, error-body suppression, endpoint restrictions, Chat Completions wire format, redirect refusal, response streaming limits, source scaffold, packed offline install, installed CLI scaffold, and TypeScript declarations.

Not executed: OCI builds, live managed inference, OpenShell filesystem/egress denial tests, DeepSeek configuration boot, native dependencies, GPU inference, AMD64/ARM64 runtime qualification, or official NemoClaw onboarding/lifecycle/recovery.

# Security policy — UNOFFICIAL / experimental integration

This is an independent community project, not an NVIDIA or DeepSeek security product. MIT code is provided without warranty. No sandbox certification, GDPR assessment, PII detection, or production qualification is implied.

## Trust boundary

Treat images, adapter manifests, executable commands, profiles, plugins, and configuration-generation code as **trusted operator-controlled inputs**. A valid manifest can still intentionally execute dangerous code. The validator and process runner are defense in depth; only the separately configured sandbox can enforce permissions against a hostile harness.

`runHarness()` and `--allow-host` execute code in the current environment. Do not use them to test unknown plugins on a workstation containing credentials. `--managed` verifies immutable configuration and non-root identity, but does not attest that OpenShell is present or enforcing a policy.

Raw upstream provider keys must remain outside the harness. The SDK uses a public placeholder, filters ambient environment variables, rejects credential URL syntax, and suppresses provider error bodies. It does **not** scan all configuration strings or successful stdout for secrets. Proxy variables are trusted deployment input and may themselves contain sensitive credentials; review their scope. Do not place secrets in manifests, task argv, examples, snapshots, or qualification evidence.

## Specific limits

Process-group termination does not contain descendants that deliberately escape the group; use the outer sandbox. SDK resource limits cover task size, captured output, deadlines, and response bodies, not a full CPU/memory/cgroup quota. CLI `--task-file` reads a caller-selected local file before validating task size; do not expose the CLI directly as an untrusted network service.

The generic writable state home is suitable only for a reviewed harness. DeepSeek gets a narrower example with a read-only home/profile and specific writable data directories. Even there, disabling known Cordis rows is not proof that all tools, plugins, settings seams, executable snapshots, or future upstream behavior are contained. Revalidate the effective runtime and actual forbidden accesses.

No broad network policy is emitted. Inference is expected to use an existing managed route; do not fix a failing inference test by allowing arbitrary outbound Internet access or disabling TLS validation. Landlock is a hard requirement in our baseline.

Image digest validation checks syntax, not authenticity or provenance. Digest-pinned bases do not freeze apt repositories; use a reviewed dependency closure and build attestation for release. Generated candidate contexts, source-review records, and version checks are not accepted NVIDIA qualification receipts.

## Reporting

Please do not post secrets or live exploit credentials in public issues. Use GitHub private vulnerability reporting for this repository **when enabled**; otherwise contact the maintainer through their public GitHub profile to arrange a private channel. This project does not promise a staffed response window. Report upstream defects through the affected upstream project's own security process, not as though this template were their supported integration.

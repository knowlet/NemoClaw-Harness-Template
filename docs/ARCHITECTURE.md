# Architecture and compatibility — UNOFFICIAL

## Layers

```text
Operator / independent SDK CLI
    |  validates community data, constructs explicit argv
    v
OpenShell BYOC gateway (separately installed and configured)
    |  authoritative filesystem / network / process enforcement
    |  external provider credential custody and managed inference route
    v
Container: non-root SDK launcher -> your complete harness
    |  stdin or argv, bounded process execution
    +-> https://inference.local/v1
```

The SDK does not load third-party code into the NemoClaw host CLI. Creating a BYOC sandbox is **not equivalent** to NemoClaw owning that agent's onboarding, recovery, state migration, image release, or supported lifecycle. Our CLI never edits NemoClaw's installed source or registers arbitrary runtime manifests.

## Source-reviewed baselines

Reviewed on 2026-09-17. These are source-reading anchors, **not an E2E-certified compatibility matrix**.

| Upstream | Inspected revision / contract |
| --- | --- |
| NemoClaw | `eb10bf0b93f36968c841c96f58b081bc1301c485`; internal agent manifests and extension taxonomy |
| OpenShell | `c502be9fd73c41bab25f0a88587b7a3d90c96b55`; BYOC explicit command, non-root identity, `/sandbox`, `iproute2`, policy format |
| DeepSeek Harness | `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`; source package version `0.1.6-alpha.1`, CLI profiles, Cordis rows, llm-pi-ai settings override |
| Node.js | Local SDK floor 22.16; managed image floor 24.5 chosen for built-in proxy support |

The DeepSeek upstream epic originally evaluated a different release candidate (`0.1.0-rc.7`). This template **does not** combine that package with patches taken from a newer source tree. Source version strings also do not prove a package was published to npm or that an image contains exactly that source.

OpenShell's current native-provider workflow and NemoClaw's managed `inference.local` integration can differ by release. The SDK deliberately targets a **pre-existing NemoClaw-compatible managed inference route**; it does not assume that the latest standalone OpenShell automatically provides that route. Verify the installed CLI help and your gateway's actual routing before deployment.

## Why there is no official manifest exporter

The upstream [extension decision](https://github.com/NVIDIA/NemoClaw/blob/eb10bf0b93f36968c841c96f58b081bc1301c485/docs/reference/extension-taxonomy-sdk-readiness.mdx) explicitly does not offer a public plugin SDK or arbitrary executable extension point. A fake `manifest.yaml` that passes our own checks but fails NemoClaw would be misleading.

To make a harness a first-class NemoClaw runtime, contribute a repository-owned integration against the exact upstream revision: agent package and image closure, real manifest validation, dispatch/lifecycle support, state/recovery rules, managed inference, policy review, dual-architecture qualification, then maintainer-approved activation. The [DeepSeek epic](https://github.com/NVIDIA/NemoClaw/issues/9328) is a planning reference, not an activation receipt.

## Release qualification still required

Before distributing a production runtime, record exact source and lockfile hashes, base/runtime image digests, SBOM/license review, NemoClaw/OpenShell versions, architecture, compute driver, effective policy hash, model and protocol, CA/proxy behavior, and the result of real negative tests. Test protected file writes, forbidden egress, provider-key absence, configuration replacement attempts, timeout/restart behavior, and the actual tool calls your workload needs.

This SDK does not create an accepted qualification receipt, snapshot executable trust, sign artifacts, or certify compliance. The generated policy uses Landlock `hard_requirement`; hosts unable to enforce it should fail, not silently fall back to unrestricted execution.

## Primary references

- [NemoClaw extension taxonomy](https://github.com/NVIDIA/NemoClaw/blob/eb10bf0b93f36968c841c96f58b081bc1301c485/docs/reference/extension-taxonomy-sdk-readiness.mdx)
- [NemoClaw DeepSeek epic](https://github.com/NVIDIA/NemoClaw/issues/9328)
- [OpenShell BYOC](https://github.com/NVIDIA/OpenShell/blob/c502be9fd73c41bab25f0a88587b7a3d90c96b55/examples/bring-your-own-container/README.md)
- [OpenShell policy example](https://github.com/NVIDIA/OpenShell/blob/c502be9fd73c41bab25f0a88587b7a3d90c96b55/examples/sandbox-policy-quickstart/policy.yaml)
- [DeepSeek CLI](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/cli/README.md)
- [DeepSeek llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/llm/llm-pi-ai/README.md)
- [Node built-in proxy support](https://nodejs.org/api/http.html#built-in-proxy-support)

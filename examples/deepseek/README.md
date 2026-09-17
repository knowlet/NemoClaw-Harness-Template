# DeepSeek headless candidate — UNOFFICIAL / EXPERIMENTAL

**Not an official NVIDIA or DeepSeek integration. Not live-E2E-qualified.** The reusable SDK is directly runnable; this candidate additionally requires a separately reviewed DeepSeek runtime image and a configured OpenShell managed route. DSH is not included in the SDK tarball.

## Exact review anchor

Source: `deepseek-ai/deepseek-harness` at `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`; source package version `0.1.6-alpha.1`. This is not a claim that the same version is published to npm. Do not use `@latest` or mix this patch with the older `0.1.0-rc.7` from the upstream NemoClaw epic.

Provide an **image digest** built from the reviewed source/lockfile, with `/usr/local/bin/dsh`, Node 24.5+, a Debian-compatible package manager, and UID/GID 1000 available. Review the native build dependencies, bundled plugins, licenses, and SBOM. A matching `dsh --version` is only a consistency check, not provenance proof.

## Generate a candidate context

From the SDK source checkout or installed package directory:

```bash
node examples/deepseek/prepare.mjs ./dsh-candidate your-managed-model \
  registry.example/your-reviewed-dsh@sha256:YOUR_REAL_64_HEX_DIGEST
```

Replace the illustrative registry and digest with your actual reviewed image. The generator refuses mutable tags. It does not fetch the image, execute DSH on the host, create an inference route, or qualify the runtime.

The output includes `adapter.json`, `managed.cordis.patch.yml`, `deepseek-launch.mjs`, `verify-build.mjs`, `source-review.json`, `policy.yaml`, `Dockerfile`, and the self-contained SDK. Build the generated context with the engine used by your gateway. Publish and address the resulting candidate by its own digest before a non-development launch.

During image build, the candidate verifies the version, initializes the shipped headless profile with `--dump-config`, sets `patchReload: startup`, and retains the effective configuration for review. These are executable build steps using your trusted DSH image; they have **not** been run in this repository's local validation environment. Upstream drift fails the build rather than silently broadening permissions.

## Boundaries this example tries to establish

The launcher passes one task to:

```text
/usr/local/bin/dsh --profile headless --patch /etc/nha/managed.cordis.patch.yml TASK
```

It does not accept extra CLI flags, user profile names, or user overlays. Tasks must fit in 16 KiB and must not begin with a dash. They are visible in process argv: do not put secrets there.

The final Cordis patch sets the `llm-pi-ai` route to `https://inference.local/v1`, selects the configured model, and references only `NHA_INFERENCE_TOKEN=openshell`. It disables the settings plugin, because **settings can override a provider route after composition**. A last patch by itself is not enough. Known HMR, shell-tool, filesystem-skill, and telemetry rows are disabled as defense in depth; this is not an exhaustive capability proof.

`DSH_HOME` and its profiles are root-owned and read-only to the runtime. Only `sessions`, `storages`, `attachments`, the workspace, and temporary storage are writable in this candidate. The whole home is deliberately not writable. Actual state paths and startup writes must be checked against the exact runtime; add only narrowly reviewed paths if the pinned runtime requires them. Do not solve a failure by making the entire home writable.

## Still required before real use

Confirm the effective Cordis tree, profile-resolution writes, dependency/native-module behavior, managed CA/proxy routing, model API/tool-call compatibility, absence of real provider credentials, denied alternate endpoints, denied managed-config writes, and every plugin/tool you enable. Test both target architectures and record exact image/policy/source hashes. No live DSH call, model call, container build, OpenShell sandbox, or architecture qualification was performed for the initial SDK delivery.

This example does not implement `dsh web`, browser authentication, plugin installation, MCP enablement, snapshot restoration, model switching, or automatic NemoClaw registration. Treat failures as incomplete qualification, not a reason to disable the outer sandbox.

Primary references: [CLI](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/cli/README.md), [llm-pi-ai settings](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/llm/llm-pi-ai/README.md), [NemoClaw epic](https://github.com/NVIDIA/NemoClaw/issues/9328).

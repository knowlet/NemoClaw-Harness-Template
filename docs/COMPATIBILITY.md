# Upstream candidate qualification — UNOFFICIAL

The supported `NATIVE_CONTRACT` remains revision-locked. A passing forward-candidate
qualification never changes that pin or promises that the default package works
on arbitrary upstream revisions.

## Complete native home migration

NemoClaw's complete-home migration (upstream PR #12340, commit
`a4ab72ee8ae1017c4fb3d468022dad7890be860e`) retired `state_dirs`, `state_files`, and
`runtime_auth_state_dirs`. The pinned selective-state generator remains unchanged.
To evaluate the new contract explicitly, the compatibility runner accepts:

```sh
node scripts/compatibility.mjs \
  --checkout pinned=.upstream/NemoClaw-pinned \
  --checkout candidate=.upstream/NemoClaw-main \
  --state-contract candidate=complete-home-v1 \
  --build --deploy --gateway nemoclaw \
  --json reports/nemoclaw-compatibility.json
```

The profile applies only to a freshly generated, byte-matching SDK fixture before
installation in the candidate checkout. It removes exactly the starter's
selective `sessions` inventory. It refuses modified packages, repeat migrations,
unknown profiles, invalid revisions, and the supported pin. It never patches the
upstream loader, changes an installed user manifest, retries with relaxed
validation, or disables cleanup gates.

The package metadata retains the template's original `contract` provenance and
adds an explicit `qualification` override naming the candidate revision, profile,
and before/after manifest SHA-256 digests. The durable case report includes that
record as `manifestQualification`; `supportedUpstream` remains false. This is a
qualification-only migrated package, not a newly supported production package.
Existing selective-state packages are not silently migrated.

With `--deploy`, a complete-home case must pass onboarding and a sandbox task,
seed run-unique session, workspace, and previously unlisted state files, run the
upstream `sandbox rebuild NAME --yes` command without force, verify all seeded
contents, and execute the harness again. Only then is
`manifestQualification.persistenceVerified` true. Loader-only qualification leaves
it false. Existing ownership checks, failure diagnostics, native cleanup, and
final CI gates apply to every failure in this sequence.

Loader rejection now preserves a bounded, credential-redacted `error` and
`LOADER_REJECTED` code in the final artifact. A failed candidate is distinct from
a failed pin; inspect each case's label, actual revision, and failed stage.
Do not update the pin solely to silence a floating-candidate failure.

Promoting the new state model into the default SDK is a separate contract/version
migration requiring reviewed runtime and persistence evidence. See
[NATIVE.md](NATIVE.md) for the supported packaging contract and
[VALIDATION.md](VALIDATION.md) for qualification scope.

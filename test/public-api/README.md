# Public declaration snapshots

These are exact emitted declaration bytes from `0ecb49d`, independently built and
verified byte-for-byte against base `develop` at `88eba54` with TypeScript 5.8.3.
The `.snap` suffix preserves the emitted files' lack of a final newline.

`npm run test:package` checks the installed npm tarball's public declaration entry
points and all relative declaration dependencies against these files. It also
rejects missing or obsolete snapshots. Consumer compilation remains a separate
check. The package smoke runs in `npm run check` and CI.

For an intentional public API change, build and inspect the declaration diff,
then explicitly copy the reviewed emitted declarations to their matching paths
here with `.snap` appended (for example, `dist/src/types.d.ts` maps to
`test/public-api/dist/src/types.d.ts.snap`). Add snapshots for new public entry
points and dependencies, remove obsolete ones, and commit the reviewed snapshot
diff with the API change. Preserve every byte, including line endings and source
map comments. Checks never rewrite snapshots.

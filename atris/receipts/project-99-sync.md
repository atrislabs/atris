# Project 99 sync and health days

Session readers now deduplicate contract identities and replay in stable timestamp order. Today's health summary uses the latest record for the local date, preserving missing totals as unknown in text and JSON.

Sync unions missing lines for both targets. Personal sync remains unchanged: it uses user Bearer credentials, pages by server received-time cursor, sends at most 500 lines per request, and rejects serialized lines over 2048 bytes. Workspace snapshots now read every direct `atris/99/sessions.*.jsonl` file plus legacy `atris/99/sessions.jsonl`. Each device uploads only `atris/99/sessions.<device_id>.jsonl`. The existing transport accepts complete file contents, so uploads preserve every existing byte of this device's file and append missing lines. Other device files and the legacy file are never uploaded or modified.

Configuration: `~/.atris/99/config.json`, overridden by `ATRIS_99_CONFIG`. Personal defaults to `app_slug: "project-99"`; workspace requires the business slug and optionally a workspace id, otherwise the business default is used. No sync block prints `sync is off (local only)`. Account and target specific cursors and acknowledged identities live in `~/.atris/99/sync-state.json`, saved atomically after successful merge. Workspace sync generates one device UUID under the state lock and atomically stores it as `device_id` before uploading, so failed requests and lost acknowledgements retain the same identity across runs. Dry runs save nothing.

```text
device a -> sessions.<a>.jsonl --+
device b -> sessions.<b>.jsonl --+-> union -> each local log
legacy   -> sessions.jsonl -----+
```

Personal records still require backend deployment. No live sync API was called during development or verification.

Changed files for device workspace sync:
- `lib/ninety-nine-sync.js`: collection reads and device-only appends.
- `commands/ninety-nine.js`: stable device identity, atomic state saves and help.
- `test/ninety-nine.test.js`: mocked HTTP concurrency and separate-process identity coverage.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: routes and current references.
- This receipt. The test file already appears in `test/fast-tests.txt`.

Proof:
- `atris worktree guard`: exit 0, `atris worktree guard: ok`.
- `npm ci`: exit 0, `up to date, audited 1 package in 2s`, `found 0 vulnerabilities`; no dependencies added.
- `node --test test/ninety-nine.test.js`: exit 0; tests 60, suites 0, pass 60, fail 0, cancelled 0, skipped 0, todo 0.
- `git diff --check`: exit 0, no output.

Coverage includes two devices uploading from simultaneous stale snapshots, later appends and convergence without lost lines, legacy and all device-file reads, preserved existing bytes, ignored unrelated files, stable identity across separate CLI processes after an upload acknowledgement fails, and unchanged personal sync behavior. All HTTP requests in sync tests use a mocked transport.

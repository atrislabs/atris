# Project 99 sync and health days

Session readers now deduplicate contract identities and replay in stable timestamp order. Today's health summary uses the latest record for the local date, preserving missing totals as unknown in text and JSON.

Sync unions missing lines for both targets. Personal sync uses user Bearer credentials, pages by server received-time cursor, sends at most 500 lines per request, and rejects serialized lines over 2048 bytes. Workspace read-back exists: the filtered snapshot route reads `atris/99/sessions.jsonl`; the existing file sync route writes its union. Workspace updates send the complete merged file because the existing route accepts file contents.

Configuration: `~/.atris/99/config.json`, overridden by `ATRIS_99_CONFIG`. Personal defaults to `app_slug: "project-99"`; workspace requires the business slug and optionally a workspace id, otherwise the business default is used. No sync block prints `sync is off (local only)`. Account and target specific cursors and acknowledged identities live in `~/.atris/99/sync-state.json`, saved atomically after successful merge. Dry runs read remote records and print missing lines without saving either log or the cursor.

Personal records still require backend deployment. No live sync API was called during development or verification.

Changed files:
- `lib/ninety-nine.js`: contract identity, stable replay, health parsing and presentation.
- `lib/ninety-nine-sync.js`: shared API helper, personal paging and batches, workspace read and write.
- `commands/ninety-nine.js`: sync command, configuration, locks, cursor storage, health output and help.
- `bin/atris.js`: await asynchronous sync and update help.
- `test/ninety-nine.test.js`: mocked HTTP coverage and real command dispatch under a mocked transport.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: routes and current references.
- This receipt. The test file already appears in `test/fast-tests.txt`.

Proof:
- `atris worktree guard`: exit 0, `atris worktree guard: ok`.
- `npm ci --offline`: exit 0, zero vulnerabilities, no dependencies added.
- `node --test test/ninety-nine.test.js`: exit 0; tests 56, suites 0, pass 56, fail 0, cancelled 0, skipped 0, todo 0.
- `git diff --check`: exit 0, no output.

Coverage includes older phone records appended after newer Mac starts, equal-time stability, unknown health fields, missing configuration and auth, identity deduplication, received-time cursor persistence, account separation, 500-line batches, the 2 KB UTF-8 limit, pulls over 1000 lines, interrupted upload recovery, unchanged repeated sync, and dry-run preservation for both targets. All HTTP requests in sync tests use a mocked transport.

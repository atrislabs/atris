# Missing folders hide ordinary Git locks

Added a real cleanup audit: preview reports a missing folder but omits both a retained private index.lock and a shared packed-refs.lock. The CLI returned exit 0, preserved the moved README, both locks, and the branch, and wrote no removal record.

## Verdict

Proceed with changes. The missing-folder lookup only reads Git's special `locked` file. Ordinary private and shared lock files remain invisible even though the mission requires exact paths and ages. Extend the main-repository lookup to inspect the matching private metadata and shared metadata using the same exclusions as the activity guard. Keep missing folders and branches untouched.

Plan: create disposable copy -> write two aged locks -> move copy -> run real preview -> assert retained files and omitted paths.

## Real command proof

`node atris/receipts/2026-10-14-missing-ordinary-lock-check.js`, exit 0. This invokes `node bin/atris.js land --reap --force --no-remote --dry-run` in a generated local Git repository. No forwarding executable or mocked Git is used. Only generated files are moved; the fixture stays on disk.

Output excerpt:

```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-IR6F82
kept, left alone: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-IR6F82/landed-with-lock (folder is missing)
cli exit: 0
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-IR6F82/repo/.git/worktrees/landed-with-lock/index.lock (7200s old)
lock reported: false
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-IR6F82/repo/.git/packed-refs.lock (7200s old)
lock reported: false
missing folder reported; two ordinary lock paths omitted; moved files and branch retained; no removal recorded
```

The audit asserts the omission to keep a reproducible advisory case. Change those assertions when the repair lands. The follow-up below also proves actual cleanup behavior on the generated fixture.

Files edited: `atris/receipts/2026-10-14-missing-ordinary-lock-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`. Existing edits in `bin/atris.js` and the rendered task view were left alone.

Required verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0. Exact summary: tests 19, suites 0, pass 19, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 12011.733.

Commands also run: git status, mission status, brain activate (plan only, exit 2), task list, task new, task claim, and task note. The existing workspace was preserved.

Progress: one real preview, two omitted lock paths, zero lost files or branches, zero removal records.

next_push: Extend missing-folder lock discovery to report ordinary private and shared lock paths and ages without removing missing folders.

layer: behaviors

## Actual cleanup follow-up

Extended the existing audit to invoke preview and actual cleanup in sequence. Both returned exit 0 and omitted the same two ordinary lock paths and ages. The moved README, branch, private index.lock and shared packed-refs.lock survived both runs; no removal record was written.

Verdict: proceed with changes. The narrow repair should share the ordinary lock scanner between existing and missing folders, scanning only matching private metadata and common metadata with the existing exclusions. The most likely failure is naming another copy's private lock as this copy's activity; require a sibling-copy fixture before committing the repair. Keep missing folders and branches untouched.

Plan: matching metadata -> shared lock scanner -> exact paths and ages -> retain missing folder and branch.

Real proof: `node atris/receipts/2026-10-14-missing-ordinary-lock-check.js`, exit 0, invokes both `node bin/atris.js land --reap --force --no-remote --dry-run` and `node bin/atris.js land --reap --force --no-remote` against generated data. Fixture: `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-Eswmox`.

Actual output excerpt:

```text
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-Eswmox/landed-with-lock (folder is missing)
cli exit: 0
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-Eswmox/repo/.git/worktrees/landed-with-lock/index.lock (7201s old)
lock reported: false
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-Eswmox/repo/.git/packed-refs.lock (7201s old)
lock reported: false
preview and cleanup reported a missing folder; both omitted two ordinary lock paths; moved files and branch retained; no removal recorded
```

Required verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0. Exact summary: tests 19, suites 0, pass 19, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 6391.373583.

Files edited: existing audit, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and `atris/team/architect/logs/2026-10-14.md`. No new filenames or production behavior changes. Commands: mission status, git status, brain activate (plan only, exit 2), atris, task list/new/claim/note, mission goal, real audit, frozen test command. Existing unrelated edits remain intact.

Progress: two real CLI runs, two omitted paths per run, zero lost files or branches, zero removal records.

next_push: Share ordinary lock scanning for missing folders, with a sibling-copy case proving private lock ownership.

layer: behaviors

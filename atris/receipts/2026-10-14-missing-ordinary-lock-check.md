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

## Neighboring private lock ownership

Extended the audit with an aged neighboring copy and its private index.lock. Both real preview and cleanup reported that lock and its age only on its owner's line, while the missing copy still omitted its own private and shared lock details. Both copies, both branches, and all three locks survived; no removal record appeared.

Verdict: proceed with changes. The repair must inspect the matching private metadata and common metadata, excluding other copies' private metadata. The concrete safeguard is now executable: each copy's explanation must exclude the other copy's private lock. A shared lock can appear in the neighbor's explanation without satisfying the missing copy's reporting requirement.

Plan: aged neighboring copy -> real preview and cleanup -> compare each explanation -> preserve both copies.

Real proof command: `node atris/receipts/2026-10-14-missing-ordinary-lock-check.js`, exit 0. It invokes `node bin/atris.js land --reap --force --no-remote --dry-run` and `node bin/atris.js land --reap --force --no-remote` against generated local data. Fixture: `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-qhyLId`.

Output excerpt:

```text
cli exit: 0
neighbor private lock reported only for its owner: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-qhyLId/repo/.git/worktrees/neighbor-copy/index.lock
lock reported for missing copy: false
lock reported for missing copy: false
preview and cleanup omitted two missing-copy lock paths; neighbor private lock named only for its owner; both copies and branches retained; no removal recorded
```

The neighbor's CLI explanation named `index.lock (7200s old)` in both runs. Initial audit attempts exposed the new-folder grace and a shared lock being reported on the neighbor's line. The fixture now ages the neighbor beyond that grace and checks omissions per copy rather than across the entire output.

Required verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0. Exact summary: tests 19, suites 0, pass 19, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 6423.019416.

Files edited: `atris/receipts/2026-10-14-missing-ordinary-lock-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`. No new filenames. Existing unrelated edits remain intact. Administrative commands: mission status, git status, brain activate (plan only, exit 2), atris, task list/new/claim/note/ready, git diff --check, commit, and push.

Progress: two real CLI runs; one neighboring private lock correctly attributed with age; two missing-copy lock details still omitted; zero lost copies, branches, or locks; zero removal records. This is an advisory proof increment, not a production repair.

next_push: Share ordinary lock scanning for missing folders and require each copy's explanation to exclude neighboring private locks.

layer: behaviors

## Ordinary lock reporting repair

Missing-folder explanations now name ordinary private and shared locks with their ages. The existing activity scanner is reused, so object storage and neighboring private metadata stay excluded. No folder-removal behavior changed.

Plan: matching registered metadata -> shared lock scanner -> exact paths and ages -> keep files and branches.

Real command: `node atris/receipts/2026-10-14-missing-ordinary-lock-check.js`, exit 0. It invokes `node bin/atris.js land --reap --force --no-remote --dry-run` and `node bin/atris.js land --reap --force --no-remote` in a disposable real repository. Fixture: `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-missing-ordinary-yKzGDF`.

Exact output excerpt:

```text
cli exit: 0
lock reported for missing copy: true
lock reported for missing copy: true
preview and cleanup named two missing-copy lock paths and ages; neighbor private lock named only for its owner; both copies and branches retained; no removal recorded
```

Both CLI explanations named the private `index.lock (7200s old)` and shared `packed-refs.lock (7200s old)`. The neighboring private lock appeared only in its owner's explanation. All three locks, both READMEs, and both branches survived. No removal record was created.

Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0. Exact output summary: tests 20, suites 0, pass 20, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 7219.844166.

Files edited: `lib/git-activity.js`, `test/worktree-removal-guard.test.js`, `atris/receipts/2026-10-14-missing-ordinary-lock-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`. No new filenames or dependencies. Existing unrelated edits were preserved.

Administrative commands: brain activate (plan only, exit 2), atris, git status, mission status, mission goal, task list/new/claim/note/ready, brain compile, git diff --check, git commit, git push. Task proof is submitted for review; no task acceptance or merge is performed.

Progress: two omitted lock details repaired, two real CLI runs, one real-runtime regression added, zero lost folders, branches, or locks, zero removal records.

next_push: Report missing folders and retained locks when member cleanup's final activity check sees the folder disappear.

layer: behaviors

Proof submission follow-up: the submission runner launches a login shell that selects Node 20.18.0. That runtime refuses the real CLI with `atris needs Node 22.13 or newer. this is Node 20.18.0.`, causing two CLI-proof failures. The bare frozen command passed again (20 passed, 0 failed, exit 0, duration_ms 7284.520542). Submission with `/opt/homebrew/Cellar/node/25.6.1/bin/node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` passed, exit 0, and wrote `atris/runs/2026-10-14-task-acw-29-2026-10-14T20-20-01-423Z.json`. The mission's frozen verifier is unchanged. No runtime policy or unrelated code was edited.

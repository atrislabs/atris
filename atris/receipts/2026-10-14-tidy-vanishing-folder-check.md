# Missing folders stay visible during final cleanup checks

Member cleanup now explains folders disappearing at the final activity check and names retained locks with their ages. The existing missing-folder lookup supplies the explanation; files and branches stay intact, and no removal record is written.

Plan: final activity failure -> check folder presence -> locate retained locks from the main repository -> keep branch.

## Real proof

Command: `node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, exit 0. It invokes the actual `node bin/atris.js member tidy --dir <generated copies>` twice, forwarding Git calls to real Git and moving only generated folders during the final check.

Output excerpt:

```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-w7cqCn
kept  landed-copy  folder is missing
cli exit: 0
kept  landed-copy  folder is missing; git lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-w7cqCn/locked/repo/.git/worktrees/landed-copy/locked (7199s old)
cli exit: 0
both timing cases passed; moved files and branches retained; no removal recorded
```

The regression test runs this same real audit and removes only its generated temporary fixture. The first attempt required exactly 7200 seconds and failed because cleanup captures its clock before the forwarding command creates the lock. The assertion now allows the ten-second setup window while still requiring the exact path and a reported numeric age.

## Required verification

`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0.

```text
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7615.474292
```

`git diff --check`, exit 0, no output.

Files edited: `lib/member-tidy.js`, `test/member-tidy.test.js`, `atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and `atris/team/architect/logs/2026-10-14.md`. Commands also inspected mission status, member identity, Git status and diff, and task state; created, claimed, and noted the bounded task. Existing entrypoint and rendered task-list edits remain outside the change.

Progress: one repaired explanation; two real timing cases; one new regression test; 21 required tests pass; no new dependencies or file names.

next_push: Extend the final-check disappearance regression to ordinary private and shared locks.

layer: behaviors


## Ordinary locks during the final check

Extended the existing real cleanup audit from two to three cases. The added case creates a two-hour-old private index lock and a three-hour-old shared packed-refs lock during the final activity check, then moves the generated folder. Exact paths, distinct reported ages, unchanged lock contents, moved file contents, retained branch, and absence of a removal record are asserted.

Plan: final activity check -> create ordinary locks -> move generated folder -> report retained lock paths and ages -> preserve files and branch.

Command: `node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, exit 0. This invokes the actual cleanup CLI three times with real Git, forwarding calls through the timing driver.

```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-RisuwJ
kept  landed-copy  folder is missing; git lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-RisuwJ/ordinary/repo/.git/packed-refs.lock (10799s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-RisuwJ/ordinary/repo/.git/worktrees/landed-copy/index.lock (7199s old)
cli exit: 0
all three timing cases passed; moved files, locks, and branches retained; no removal recorded
```

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0.

```text
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8188.005042
```

Files edited: `atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, `test/member-tidy.test.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and `atris/team/architect/logs/2026-10-14.md`. Artifacts: extended executable proof and this output receipt. Inspection commands: mission status and goal, task list/new/claim/note, Git status/diff/remote, member identity and notebook reads. Brain activation and compilation both exited 2 with a plan-only response; no generated policy files were written. Existing entrypoint, rendered task-list, and earlier member-log changes were preserved.

Progress: one added real timing case, two additional lock paths checked with different ages, three cleanup invocations passing, all 21 required tests passing. No production changes, new dependencies, or new file names.

next_push: Extend the old-folder final-check disappearance audit to ordinary private and shared locks.

layer: behaviors


## Late locks with the folder still present

Extended the existing real cleanup audit with one case that creates an ordinary private index lock and a shared packed-refs lock during the final activity check without moving the folder. Cleanup names both exact paths with distinct ages, preserves folder contents, lock contents and branch, and never attempts or logs a removal. Production code is unchanged.

Plan: resolve folder -> final activity check creates locks -> report paths and ages -> retain folder and branch.

Command: `node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, exit 0. Four actual cleanup invocations passed using real Git. Fixture left for inspection: `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-AO5Xq0`.

```text
kept  landed-copy  git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-AO5Xq0/ordinary-present/repo/.git/packed-refs.lock (10799s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-AO5Xq0/ordinary-present/repo/.git/worktrees/landed-copy/index.lock (7199s old)
cli exit: 0
all four timing cases passed; files, locks, and branches retained; no removal attempted or recorded
```

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0, Node v25.6.1.

```text
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12556.077625
```

Files edited: `atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, `test/member-tidy.test.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and an appended entry in `atris/team/architect/logs/2026-10-14.md`. Artifacts: extended executable audit and this receipt. Commands inspected mission status/goal, tasks, member identity, notebook, Git state and source; created, claimed and noted a bounded task; ran the audit and required tests. Mission task attachment was refused by an existing process lock, which was left intact. Brain activation returned a plan only, exit 2, without changing generated policy.

Review recording: the task recorder required its own invocation, so `/opt/homebrew/bin/node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` was run through `atris task ready`, exit 0. Output: `verified: ... exited 0`, `ready for approval`. Review remains pending because the explicit runtime path is outside automatic certification. Brain compilation returned a plan only, exit 0. `git diff --check` passed, exit 0, no output.

Progress: one added timing case, two exact lock paths with distinct ages, four real cleanup invocations, all 21 required tests passing. No new dependencies or filenames.

next_push: Prove ordinary locks arriving during the final old-folder cleanup check prevent removal while the folder stays present.

layer: behaviors

## Late keep marker in a still-present folder

Added a fifth case: a special Git keep marker arrives during member tidy's final check while the folder stays in place. Tidy kept the folder, its files, the marker and the branch, named the marker path and age, and never asked Git to remove anything.

Files edited: `atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, `test/member-tidy.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, `atris/team/architect/logs/2026-10-14.md`. No new files.

Real command: `node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, exit 0. It runs `node bin/atris.js member tidy --dir <generated copies>` five times against generated repositories with real Git. New case output:
```text
kept  landed-copy  git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-pnLrCF/locked-present/repo/.git/worktrees/landed-copy/locked (7198s old)
tidy: removed 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-pnLrCF/locked-present/copies
cli exit: 0
all five timing cases passed; files, locks, and branches retained; no removal attempted or recorded
```
The generated fixture folder was removed afterward.

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, Node 25.6.1, exit 0:
```text
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ duration_ms 44861.526834
```

Progress: both cleanup paths, old-folder cleanup and member tidy, now prove the same five timing cases with zero removal attempts and zero removal records.

next_push: Prove a late keep marker during the regression cleanup's final check keeps a still-present folder and names the marker age.

layer: behaviors

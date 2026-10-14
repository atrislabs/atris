Cleanup now explains folders that disappear during its final check, verified through two real cleanup commands and 19 passing tests, exit 0.

Files edited: `commands/land.js`, `test/worktree-removal-guard.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`.
Artifacts produced: `atris/receipts/2026-10-14-land-vanishing-folder-check.js` and this receipt.

Plan: scan -> plan removal -> folder moves -> final Git check fails -> name missing folder and retained lock -> keep branch.

Real-surface command: `node atris/receipts/2026-10-14-land-vanishing-folder-check.js`, exit 0.
The fixture forwards every Git call to the installed Git executable. At the second activity check it optionally locks the generated copy, then renames that copy. It never moves user files. Generated fixture folders are retained for inspection.

Output excerpt:
```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-S0Deng
command: node bin/atris.js land --reap --force --no-remote
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-S0Deng/unlocked/landed-copy (folder is missing)
  still flying (recent work, left alone): 0
cli exit: 0
command: node bin/atris.js land --reap --force --no-remote
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-S0Deng/locked/landed-copy (folder is missing; git lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-S0Deng/locked/repo/.git/worktrees/landed-copy/locked (7200s old))
  still flying (recent work, left alone): 0
cli exit: 0
both vanished folders reported; moved files and branches retained; no removal recorded
```

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Exact final output:
```text
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5971.163291
```

Progress: one timing regression added, two disappearance cases proved, zero branch removals, zero removal records. Existing entrypoint and rendered task changes were left out of the commit.

Review handoff: the login shell selected Node 20.18.0 and the real CLI refused it because Node 22.13 or newer is required. The bare frozen command passed under Node 25.6.1. Recording review with `/opt/homebrew/bin/node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` passed, exit 0, and moved the task to review. Receipt: `atris/runs/2026-10-14-task-acw-24-2026-10-14T20-07-53-422Z.json`. This explicit runtime needs a second review before automatic landing; the code and proof were committed and pushed.

next_push: Report folders disappearing during member tidy's final activity check, including retained lock paths and ages.

layer: behaviors

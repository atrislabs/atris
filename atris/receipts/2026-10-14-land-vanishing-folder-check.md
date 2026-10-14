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

## Ordinary locks during the final check

Extended the existing audit to cover ordinary private and shared locks appearing during the final old-folder cleanup check. Three real cleanup commands exited 0; all 21 required tests passed, exit 0.

Files edited: `atris/receipts/2026-10-14-land-vanishing-folder-check.js`, this receipt, `test/worktree-removal-guard.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`. No new files or dependencies.

Plan: plan removal -> create two ordinary locks -> move generated folder -> report missing folder and both locks -> keep branch.

Real command: `node atris/receipts/2026-10-14-land-vanishing-folder-check.js`, exit 0. This invokes `node bin/atris.js land --reap --force --no-remote` three times against generated repositories using real Git. Output excerpt:
```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-5wOnTO
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-5wOnTO/ordinary/landed-copy (folder is missing; git lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-5wOnTO/ordinary/repo/.git/packed-refs.lock (10800s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-5wOnTO/ordinary/repo/.git/worktrees/landed-copy/index.lock (7200s old))
cli exit: 0
all three timing cases passed; moved files, locks, and branches retained; no removal recorded
```

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0. Exact final output:
```text
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9744.222292
```

The first audit run exposed an assertion that assumed only explicit keep markers; the first test run also caught the old two-case summary expectation. Both were corrected before the passing run. Progress: one new timing case, two ordinary lock paths checked with distinct ages, three branches retained, zero removal records. Lock contents and moved file contents are checked too. Existing unrelated edits remain unstaged.

next_push: Prove an ordinary lock appearing during the final old-folder check without the folder moving still prevents removal.

layer: behaviors

Review handoff: the bare required command passed directly under Node 25.6.1. The task recorder's shell returned 18 passes and 3 failures, exit 1; its abbreviated receipt does not identify the failures. Repeating through the recorder with `/opt/homebrew/bin/node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` passed, exit 0, and placed the task in review. Receipt: `atris/runs/2026-10-14-task-acw-32-2026-10-14T20-27-02-563Z.json`. The explicit runtime needs a second review before automatic landing. This increment was committed and pushed; unrelated edits remain local.

## Late locks in a present old folder

Added proof that locks arriving just before old-folder removal keep the folder intact. Four real cleanup runs and all 21 required tests passed, exit 0.

Files edited: `atris/receipts/2026-10-14-land-vanishing-folder-check.js`, `test/worktree-removal-guard.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/receipts/2026-10-14-land-vanishing-folder-check.md`, `atris/team/architect/logs/2026-10-14.md`.

Plan: plan removal -> add private and shared locks -> keep folder present -> name both paths and ages -> retain files and branch.

Real command: `node atris/receipts/2026-10-14-land-vanishing-folder-check.js`, exit 0. It invokes `node bin/atris.js land --reap --force --no-remote` four times with real Git in generated repositories. Exact output excerpt:
```text
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-fZxayi/ordinary-present/landed-copy (git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-fZxayi/ordinary-present/repo/.git/packed-refs.lock (10799s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-fZxayi/ordinary-present/repo/.git/worktrees/landed-copy/index.lock (7199s old))
cli exit: 0
all four timing cases passed; files, locks, and branches retained; no removal attempted or recorded
```

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0. Exact final output:
```text
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11333.165958
```

Progress: one added timing case, two late lock paths and distinct ages checked, zero removal attempts or records in all four cases. Learned: a present folder takes the ordinary lock explanation, without the missing-folder prefix. No production changes, dependencies, or new filenames. Existing unrelated edits are preserved. Mission attachment reported its existing busy lock, which was left untouched.

next_push: Prove late special Git keep markers also protect a still-present old folder during the final cleanup check.

layer: behaviors

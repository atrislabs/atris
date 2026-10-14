# Member cleanup keeps Git locks

Cleanup now keeps folders with old private or shared Git locks, reports every exact lock path and age, and records successful folder removals. Verified by real CLI preview and the frozen Node checks, both exit 0.

Before building: proceed-with-changes. The single risk is treating old locks as expired and deleting unfinished Git work. Require the same activity check before preview and removal, no age expiry, and regression assertions against real Git.

Plan: landed copy -> running-program check -> private/shared Git lock check -> keep with paths and ages, or Git removal -> successful removal log.

Files edited: lib/git-activity.js; lib/member-tidy.js; test/member-tidy.test.js; atris/receipts/2026-10-14-folder-lock-preview.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md; this receipt. The task CLI also regenerated atris/TODO.md locally; that generated view is not part of this change. Existing bin/atris.js work was preserved.

Rerun: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0. Actual output excerpt:
```
✔ tidy keeps old private and shared git locks and reports every path and age (585.328875ms)
ℹ tests 9
ℹ pass 9
ℹ fail 0
ℹ duration_ms 2864.483
```
The new regression invokes actual cleanup in preview and removal modes. Both keep two-hour-old private index.lock and shared refs/heads/master.lock, report both exact paths with 7200s age, preserve folder and branch, and leave no removal record. The existing clean-removal regression now requires two records with actor, path, branch, and reason.

Real CLI proof: node atris/receipts/2026-10-14-folder-lock-preview.js
Exit: 0. Actual output excerpt:
```
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-preview-6RVvKz
kept  landed-with-lock  git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-preview-6RVvKz/repo/.git/worktrees/landed-with-lock/index.lock (7200s old)
cli exit: 0
unsafe preview observed: false
exact lock reported: true
```
Artifact: retained disposable fixture at the printed path. No user folder was removed.

Commands run: mission status; git status; brain activate; Atris boot; mission goal; task list/new/claim/note/ready; focused reads; real CLI audit; frozen checks; brain compile; git diff --check; git add of declared files; git commit; git push. Brain activate and compile returned 2 with a plan only, without changing compiled files. Mission task attachment returned 3 because a live holder owns its lock; no lock or mission settings were changed. Task ready rejected two plain-copy attempts and required its own check invocation. With the accepted result and landing sentences, its own frozen check exited 0 and the task moved to Review. Final task proof: atris/runs/2026-10-14-task-acw-1-2026-10-14T18-08-55-836Z.json. The change was committed and pushed, exit 0; no task was self-accepted.

Progress: one cleanup surface guarded; two lock scopes covered; nine checks pass; real preview no longer proposes removing the locked copy. Other removal callers remain for later increments. This check runs just before removal but does not make filesystem inspection and Git removal atomic.
next_push: Route landed-folder removal in the landing command through the shared Git-activity check and report exact lock paths and ages.
layer: behaviors

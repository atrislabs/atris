# Old-folder cleanup keeps Git locks

Old-folder cleanup now keeps folders with unfinished Git work and reports exact lock paths and ages. Real preview, forced cleanup, and the required checks exited 0.

Plan: old private and shared locks -> inspect Git activity -> keep folder and branch -> no removal record. Recheck immediately before removal to catch locks created while backing up work.
Verdict: proceed. The single risk is an old lock being mistaken for abandoned work. Locks never expire; preview and removal share the activity check.

Files edited: commands/land.js; test/worktree-removal-guard.test.js; atris/receipts/2026-10-14-land-lock-preview.js; this receipt; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md. Existing bin/atris.js and rendered TODO changes are excluded from staging.

Runtime command: `node atris/receipts/2026-10-14-land-lock-preview.js`, exit 0. Uses the actual CLI against a real disposable repository, isolates inherited Git variables, and retains the locked folder for inspection.
Actual output excerpt:
```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-lock-haX6Yc
command: node bin/atris.js land --reap --force --no-remote --dry-run
landing cleanup preview: would clear 0 pieces of work, 0 side copies:
  kept, left alone: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-lock-haX6Yc/landed-with-lock (git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-lock-haX6Yc/repo/.git/refs/heads/master.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-lock-haX6Yc/repo/.git/worktrees/landed-with-lock/index.lock (7200s old))
cli exit: 0
command: node bin/atris.js land --reap --force --no-remote
landing cleanup done: 0 pieces cleared, 0 side copies removed
cli exit: 0
folder and both locks retained; no removal recorded
```
Actual removal output also reports both full lock paths and 7200-second ages. First runtime attempt exited 1 because preview hid the reason for keeping a folder. Corrected that output and reran successfully.

Rerunnable verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0.
Actual final output excerpt:
```text
✔ reap keeps old private and shared git locks in preview and forced removal (216.007166ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0
ℹ duration_ms 3067.846834
```

Commands: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris mission goal --json; atris task list; atris; targeted reads; atris task new/claim/note/ready; git diff --check; explicit git add; git commit; git push origin HEAD.
Mission attach-task returned lock busy; used a separate bounded task without changing mission settings. Brain activate and compile returned exit 2, plan only; no generated policy files written.

Progress: one additional removal path protected, two real CLI modes proved, two old locks preserved, ten required checks passed, zero removal records for kept folders. Fleet and autopilot removal paths remain for later increments.
next_push: Route regression-folder cleanup in autopilot through the Git-activity check and removal log, with real-runtime coverage for old locks.
layer: behaviors

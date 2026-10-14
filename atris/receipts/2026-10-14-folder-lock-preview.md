# Old Git lock cleanup preview

Added a repeatable real-command audit. Cleanup preview marks a landed folder for removal despite a two-hour-old Git lock and reports neither the lock path nor its age. No removal was attempted and no production behavior changed.

Verdict: proceed-with-changes. The risk is deleting a clean folder while Git has unfinished work. Require preview and removal to share a Git-activity check, keep old locks without treating age as expiry, report each exact lock path and age, and write a removal record only after successful removal.

Plan: real old lock -> inspect Git activity -> keep with path and age -> no removal record.

Runtime command: node atris/receipts/2026-10-14-folder-lock-preview.js
Exit: 0. This invokes node bin/atris.js member tidy --dry-run --dir <fixture>/copies from a disposable repository with a real local bare origin.
Actual output:
```
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-preview-ToNJPk
lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-preview-ToNJPk/repo/.git/worktrees/landed-with-lock/index.lock
lock age seconds: 7200
would remove  landed-with-lock  work landed
tidy: would remove 1, kept 0, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-preview-ToNJPk/copies
cli exit: 0
unsafe preview observed: true
exact lock reported: false
fixture retained for inspection; no folder removal attempted
```
The audit asserts the command exits successfully, the folder and lock survive, and no removal record exists. It reports unsafe preview behavior without requiring that behavior to persist, so it can inspect a future repair. The retained fixture is disposable test data.

Required check: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0. Actual output excerpt:
```
✔ tidy removes landed clean copies and leaves everything else to git and the rules (969.656625ms)
✔ reap sees a real live process in the folder without being told (320.442125ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
ℹ duration_ms 2459.212875
```
These checks do not cover Git locks. This receipt proves a gap, not full folder protection.

Files edited: atris/receipts/2026-10-14-folder-lock-preview.js; atris/receipts/2026-10-14-folder-lock-preview.md; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md.
Commands: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris mission goal --json; atris task list --status open; atris brain activate --root . --verify; atris; targeted reads; git remote -v; git branch --show-current; git diff --check; git add (declared files only); git commit; git push.
Brain activation returned exit 2 with a write plan only. Missing local compiled files were not created. Mission settings and the existing bin/atris.js edit were preserved.

Save-check recovery: the first load check imported the executable audit while Git supplied the current commit index. Its fixture Git commands changed that index, not repository files. Restored the initially unstaged index from HEAD using git read-tree HEAD, preserving the existing command-entry edit and all working file contents. The audit now runs only as a direct command and removes inherited GIT_* environment variables from its fixture subprocesses. Re-ran the runtime audit, exit 0, with the same gap observed.

Progress: one reproducible real-command gap, one exact old-lock fixture, eight passing required checks, zero production changes.
next_push: Add shared Git-activity checking to member cleanup with a regression requiring the old lock's exact path and age in preview and actual cleanup, and no removal record.
layer: beliefs

Cleanup now has a real regression proving lock details survive failed remote lookup, verified by preview and cleanup CLI runs and all 27 required tests, exit 0.

Files edited: test/member-tidy.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md.
Artifact: atris/receipts/2026-10-14-tidy-failed-origin.md.
Task: ACW-38.
Plan: failed origin lookup -> inspect Git activity -> keep with exact lock paths and ages.
No production behavior change. The existing guard already handles this failure.
Verify command: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exact result: tests 27; pass 27; fail 0; cancelled 0; skipped 0; todo 0. Exit: 0.
Metric: one strengthened regression, two real CLI runs, three distinct lock ages, two folders and branches retained, zero removal records.
The CLI exits 1 as expected because remote lookup failed. The surrounding test exits 0.
Real commands and output:
```text
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/.agent-worktrees/repo --dry-run
tidy: could not ask origin for its main branch: fatal: '/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/gone.git' does not appear to be a git repository, so every copy is kept
kept  landed-clean  could not ask origin for its main branch: fatal: '/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/gone.git' does not appear to be a git repository; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/refs/heads/master.lock (7320s old)
kept  origin-failed-locked  could not ask origin for its main branch: fatal: '/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/gone.git' does not appear to be a git repository; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/worktrees/origin-failed-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/worktrees/origin-failed-locked/locked (7260s old)
tidy: would remove 0, kept 2, of 2 copies in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/.agent-worktrees/repo
exit: 1
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/.agent-worktrees/repo
tidy: could not ask origin for its main branch: fatal: '/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/gone.git' does not appear to be a git repository, so every copy is kept
kept  landed-clean  could not ask origin for its main branch: fatal: '/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/gone.git' does not appear to be a git repository; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/refs/heads/master.lock (7320s old)
kept  origin-failed-locked  could not ask origin for its main branch: fatal: '/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/gone.git' does not appear to be a git repository; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/worktrees/origin-failed-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/repo/.git/worktrees/origin-failed-locked/locked (7260s old)
tidy: removed 0, kept 2, of 2 copies in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-14cGd0/arena/.agent-worktrees/repo
exit: 1
```
Other commands: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris mission goal --json (no candidate); atris task list --status open; atris task new; atris task claim ACW-38 --as architect; atris task note ACW-38; git diff --check (exit 0).
Mission attachment was held by the running supervisor, so a dedicated task records this increment. Brain activation returned plan-only, exit 2; missing generated brain files were not created.
New filename contains none of the prohibited words.
next_push: Name exact lock paths and ages when Git cannot determine whether a copy has landed.
layer: behaviors

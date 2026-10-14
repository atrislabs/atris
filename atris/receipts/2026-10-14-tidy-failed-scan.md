Cleanup now names Git locks when the running-program scan fails, verified by real preview and cleanup commands and all 27 required tests, exit 0.

Files edited: lib/member-tidy.js, test/member-tidy.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md.
Artifact: atris/receipts/2026-10-14-tidy-failed-scan.md.
Task: ACW-37, architect, workspace.
Plan: failed scan -> inspect Git activity -> keep with original failure and exact lock paths and ages.
Risk addressed: the original scan failure remains visible, every copy stays kept, and each copy names only its own private locks plus shared locks.
New filenames: no protected words.

Verify command:
```sh
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
```
Exit: 0.
Output: tests 27; pass 27; fail 0; skipped 0.

Real changed-surface invocations and output:
```text
command: PATH=/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx:$PATH node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/.agent-worktrees/repo --dry-run
tidy: could not check for running programs: lsof broke, so every copy is kept
kept  landed-clean  could not check for running programs: lsof broke; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/refs/heads/master.lock (7320s old)
kept  scan-failed-locked  could not check for running programs: lsof broke; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/worktrees/scan-failed-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/worktrees/scan-failed-locked/locked (7260s old)
tidy: would remove 0, kept 2, of 2 copies in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/.agent-worktrees/repo
exit: 1
command: PATH=/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx:$PATH node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/.agent-worktrees/repo
tidy: could not check for running programs: lsof broke, so every copy is kept
kept  landed-clean  could not check for running programs: lsof broke; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/refs/heads/master.lock (7320s old)
kept  scan-failed-locked  could not check for running programs: lsof broke; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/worktrees/scan-failed-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/repo/.git/worktrees/scan-failed-locked/locked (7260s old)
tidy: removed 0, kept 2, of 2 copies in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-GS0ygx/arena/.agent-worktrees/repo
exit: 1
```
The expected CLI exit is 1 because the scan fails, not because any removal failed.
Metric: both preview and execution kept 2 folders and 2 branches, retained 3 locks with distinct ages, and produced 0 removal records.
Initial verification failed because the test expected exit 0 for an aborted CLI run. The existing CLI deliberately returns 1 for aborts; the assertion was corrected and the frozen command rerun successfully.
Commands also run: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris brain activate --root . --verify (plan only, exit 2); atris task list; atris mission goal --json; atris task new; atris task claim ACW-37 --as architect; atris task note ACW-37; git diff --check (exit 0).
Task recording reran the tests through a login shell that resolves node to /usr/local/bin/node (v20.18.0), while the direct shell uses /opt/homebrew/bin/node (v25.6.1). That repeat failed (18 passed, 9 failed); task proof is rerun with the explicit current Node executable. No mission verifier change.
next_push: Prove exact lock paths and ages remain visible when origin lookup fails.
layer: behaviors

Cleanup now reports exact lock paths and ages for folders with no branch attached, verified by real preview and cleanup commands and the required checks, exit 0.

Files edited: lib/member-tidy.js, test/member-tidy.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md. Member log appended: atris/team/architect/logs/2026-10-14.md. Existing unrelated edits were preserved.

Plan: detached folder -> inspect Git activity -> keep original reason plus exact locks and ages. No removal behavior changes.

Verify command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0.

Real command output from that invocation:

```text
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/.agent-worktrees/repo --dry-run
kept  detached-locked  not on a branch; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/repo/.git/worktrees/detached-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/repo/.git/worktrees/detached-locked/locked (7260s old)
tidy: would remove 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/.agent-worktrees/repo
exit: 0
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/.agent-worktrees/repo
kept  detached-locked  not on a branch; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/repo/.git/refs/heads/master.lock (7321s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/repo/.git/worktrees/detached-locked/index.lock (7201s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/repo/.git/worktrees/detached-locked/locked (7261s old)
tidy: removed 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-iX4tqn/arena/.agent-worktrees/repo
exit: 0
```

Required check output:

```text
✔ worktree cleanup names who removed a folder and why (131.421583ms)
ℹ tests 29
ℹ suites 0
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 24971.550125
```

Progress: one missing reporting path closed; three distinct private and shared lock ages checked in preview and execution. Files, saved branch, locks, and Git registration survive with no removal record.

Other commands: git diff --check (exit 0); atris brain compile --root . (exit 2, preview only, no generated files written).

next_push: Report exact Git lock paths and ages when tidy keeps a copy pointing outside the copies folder.
layer: behaviors

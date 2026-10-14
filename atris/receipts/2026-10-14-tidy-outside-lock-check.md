Cleanup now names exact lock paths and ages for copies pointing outside the copies folder, verified by real preview and cleanup commands and 30 passing checks, exit 0.

Files edited: lib/member-tidy.js, test/member-tidy.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md, and this receipt.
Task: ACW-41.
Plan: outside path -> inspect Git activity -> keep with original explanation and exact lock details.
Risk: an outside target must remain retained even when the Git activity scan fails. The keep decision remains unconditional.
Verify: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Result: tests 30; pass 30; fail 0; exit 0.
Progress: one retention path repaired; preview and cleanup preserve the link, outside files, branch, Git registration, and all three locks, with no removal record.

Real command output:
```text
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/.agent-worktrees/repo --dry-run
kept  outside-locked  points outside the copies folder, left alone; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/repo/.git/worktrees/outside-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/repo/.git/worktrees/outside-locked/locked (7260s old)
tidy: would remove 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/.agent-worktrees/repo
exit: 0
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/.agent-worktrees/repo
kept  outside-locked  points outside the copies folder, left alone; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/repo/.git/refs/heads/master.lock (7321s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/repo/.git/worktrees/outside-locked/index.lock (7201s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/repo/.git/worktrees/outside-locked/locked (7261s old)
tidy: removed 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-2ZjOGU/arena/.agent-worktrees/repo
exit: 0
```

Learning: every early keep decision needs the same lock explanation, including paths excluded from removal.
next_push: Report exact lock paths and ages when Git refuses a tidy removal after the activity check.
layer: behaviors


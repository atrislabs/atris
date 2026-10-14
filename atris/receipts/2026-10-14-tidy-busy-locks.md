Busy-folder cleanup now names exact lock files and ages, verified by real CLI preview and execution and all 27 required tests, exit 0.

Files edited: lib/member-tidy.js, test/member-tidy.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md.
Artifact: atris/receipts/2026-10-14-tidy-busy-locks.md.
Verify command: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0. Progress: one added real-runtime regression, three lock paths with distinct ages in preview and cleanup, zero folders removed, branch and files retained, no removal record.
Real surface commands: node bin/atris.js member tidy --dir <generated copies directory> --dry-run; node bin/atris.js member tidy --dir <generated copies directory>, each run inside the busy generated copy, each exit 0.
Output excerpt (exact generated paths):
```text
kept  busy-locked  landed, but something is still running inside it; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G9II1B/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G9II1B/arena/repo/.git/worktrees/busy-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G9II1B/arena/repo/.git/worktrees/busy-locked/locked (7260s old)
kept  busy-locked  landed, but something is still running inside it; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G9II1B/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G9II1B/arena/repo/.git/worktrees/busy-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G9II1B/arena/repo/.git/worktrees/busy-locked/locked (7260s old)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 23221.478709
```

Other commands: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris task list --status open; atris mission goal --json; atris task new; atris task claim; atris task note; git diff --check (exit 0).
Brain activate and compile both returned plan-only output, exit 2, with no generated policy changes. Existing bin/atris.js and atris/TODO.md edits were left out of staging.
Stop: one bounded increment complete.
Learning: an earlier keep reason can hide Git locks even when removal protection is already correct.
next_push: Name lock paths and ages when tidy keeps every copy because the running-program scan fails.
layer: behaviors


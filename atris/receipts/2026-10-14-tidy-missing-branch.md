Cleanup now names exact lock paths and ages when Git cannot tell whether work has landed, verified by real preview and cleanup runs and the required checks, exit 0.

Files edited: lib/member-tidy.js, test/member-tidy.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md.
Artifact: atris/receipts/2026-10-14-tidy-missing-branch.md.
Plan: missing branch reference -> ancestry check fails -> inspect Git activity -> retain folder with both explanations.
Verify: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0.
Exact check output:
```text
✔ worktree cleanup names who removed a folder and why (142.685416ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 24716.534542
```
Real commands and output:
```text
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/.agent-worktrees/repo --dry-run
kept  branch-missing-locked  git could not tell if it landed: fatal: Not a valid object name refs/heads/branch-missing-locked; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/repo/.git/worktrees/branch-missing-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/repo/.git/worktrees/branch-missing-locked/locked (7260s old)
tidy: would remove 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/.agent-worktrees/repo
exit: 0
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/.agent-worktrees/repo
kept  branch-missing-locked  git could not tell if it landed: fatal: Not a valid object name refs/heads/branch-missing-locked; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/repo/.git/refs/heads/master.lock (7321s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/repo/.git/worktrees/branch-missing-locked/index.lock (7201s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/repo/.git/worktrees/branch-missing-locked/locked (7261s old)
tidy: removed 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-QwmCCq/arena/.agent-worktrees/repo
exit: 0
```
Metric: one fixed error path, one new regression, two real CLI runs, three lock files with distinct ages retained, one folder and its Git record retained, zero removal records.
Other commands: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris; atris task list --status open; atris mission goal --json; atris task new; atris task claim ACW-39 --as architect; atris task note ACW-39; atris brain activate --root . --verify; atris brain compile --root .; git diff --check.
Brain commands returned plan-only, exit 2, and no generated policy files were written. Existing unrelated changes in bin/atris.js and rendered TODO were left out of this change.
next_push: Name exact lock paths and ages when tidy keeps a detached copy.
layer: behaviors

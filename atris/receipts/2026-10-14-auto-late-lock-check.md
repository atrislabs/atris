Automatic cleanup now names late lock files and ages after Git refuses removal, verified by real Git cleanup and 30 passing checks, exit 0.

Files edited: commands/autopilot.js; test/worktree-removal-guard.test.js; atris/receipts/2026-10-14-autopilot-folder-check.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md. Artifact: this receipt.

Plan: passing activity scan -> late locks -> real Git refusal -> fresh scan -> named paths and ages -> retained folder, no removal recorded.

Real surface command: node atris/receipts/2026-10-14-autopilot-folder-check.js
Exit: 0. Runs the production regressionCheck routine against real Git with a forwarding executable inserting locks at removal. Output excerpt:
```
  kept /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.regression-worktree-fbc52bd6: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.git/packed-refs.lock (14400s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.git/worktrees/-regression-worktree-fbc52bd6/index.lock (10800s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.git/worktrees/-regression-worktree-fbc52bd6/locked (7200s old)
{"hash":"fbc52bd68175d681d929d881c9c389cacbb80fd5","slug":"late-refused","pass":true,"cleanup":{"path":"/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.regression-worktree-fbc52bd6","removed":false,"reason":"git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.git/packed-refs.lock (14400s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.git/worktrees/-regression-worktree-fbc52bd6/index.lock (10800s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-EuPlvV/.git/worktrees/-regression-worktree-fbc52bd6/locked (7200s old)"}}
Git refusal after a passing check named three locks and distinct ages; files and Git record retained; no removal recorded
```

Rerun: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0, Node v25.6.1. Exact summary: tests 30; suites 0; pass 30; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 26586.608417.

Metric: one additional timing case, three late locks with distinct ages, zero removals recorded for the refused folder, 30 checks passing. No dependencies or protected new filenames.
Learning: a fresh scan after Git refuses removal exposes locks that did not exist when cleanup first checked.
Other commands: atris brain activate --root . --verify; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; git status --short; atris task list; atris mission goal --json; atris; atris task new/claim/note/ready; git diff --check; atris brain compile --root .; git add; git commit; git push. Brain commands returned exit 2, plan only, with no writes. No native goal candidate was offered. Initial fixture run failed because a previous case's shared lock prevented reaching removal; the fixture now clears only that previous generated lock before the new case.
Landing: task proof is in Review. Safe internal changes are prepared for commit and push; no acceptance or merge performed. Initial ready attempts required a plain benefit and process-local command evidence; the accepted proof points to this detailed receipt.
next_push: Explain the runtime difference between direct passing checks and automatic review failures.
layer: behaviors

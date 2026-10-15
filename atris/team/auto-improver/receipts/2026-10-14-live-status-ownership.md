# Live-status ownership setup

The live-status test uses one fewer CLI launch; four focused runs and all 35 required checks passed, exit 0.

- Task: AIC-10
- Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.
- Change: claim ownership through the production store in the fixture connection after all three rows exist. Preserve all three sequential status CLI invocations and every status/history assertion.
- Timing finding: the first direct-store attempt failed because creation and claim shared a timestamp, yielding `note` instead of `claim` at the front of the history feed. The feed sorts only by timestamp. Poll past the final seed timestamp before claiming, matching the existing ordered-seed approach without a fixed sleep.
- Production path inspected: commands/task.js cmdClaim calls taskDb.claimTask, which appends the real claimed event. The first status call rebuilds the projection.
- Focused command (run four times before and after): `node --test --test-name-pattern='^task status gives web and Swarlo a compact live contract$' test/commands.test.js`
- Before test milliseconds: [532.855833, 537.102042, 537.374708, 534.333708], all exit 0.
- After test milliseconds: [415.324750, 418.258666, 416.753500, 413.335083], all exit 0.
- Metric: four CLI launches become three. Mean focused test time 535.42ms before, 415.92ms after, 22.3% less in a small local sample.

Actual final focused output:
```text
✔ task status gives web and Swarlo a compact live contract (413.335083ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 552.476417
exit 0
```

Required command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Actual output excerpt:
```text
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13270.514375
exit 0
```

Bookkeeping: atris brain activate --root . --verify (exit 2, plan only); atris; git status --short --branch; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris mission goal --json (no candidate); atris task list --status open; atris task new; atris task claim AIC-10 --as auto-improver; atris task note AIC-10; git diff --check (exit 0); atris task ready AIC-10; atris brain compile --root .; git add declared files; git commit; git push.
Readiness initially refused proof-only test claims because they need execution in its own process. Retried with the focused command above through `atris task ready AIC-10 --verify`, using `/opt/homebrew/bin/node` to avoid the known login-shell Node mismatch, exit 0. This additional focused run passed and moved the task to Review. Readiness receipt: atris/runs/2026-10-15-task-aic-10-2026-10-15T02-45-07-956Z.json. Automated acceptance remains gated. Brain compile was plan-only, exit 2. Optional brain context files were absent. Existing edits in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md are excluded from the commit.

next_push: inspect the review-debt next-selection test for a setup-only ownership launch that can use the real store.
layer: capabilities

# Revision inspection batch

Revision testing now runs the display and stale-proof refusal together. The focused test and all 35 required health checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, atris/team/auto-improver/receipts/2026-10-14-revision-inspection-batch.md.

Change: await both real CLI checks after revision and before fresh readiness. Display reads the task; acceptance with no fresh proof exits before task writes. All original assertions remain. No product code changed.

Metric: six CLI launches remain; sequential launch stages fall from six to five. One local focused sample fell from 899.646042ms to 720.272667ms (about 20 percent). This is not a stable timing claim.

Proof commands and actual output:

```text
node --test --test-name-pattern='^task revise sends ready work back to claimed with revision count$' test/commands.test.js
Before: ✔ task revise sends ready work back to claimed with revision count (899.646042ms)
After: ✔ task revise sends ready work back to claimed with revision count (720.272667ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
exit 0 for both

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 14759.84025
exit 0

git diff --check
(no output)
exit 0
```

Brain activation and compilation returned plan-only, exit 2; no generated brain files were written. Requested brain and wiki index files were absent. Pre-existing lib/task-db.js, test/landing-proof.test.js and rendered TODO changes are excluded from this commit.

The task is in Review, not accepted. Task-ready reran the focused test successfully with the installed Node 25 runtime. Saved proof: atris/runs/2026-10-15-task-aic-24-2026-10-15T04-31-41-098Z.json. The absolute runtime path requires a second review for automatic certification. The first landing sentence was rejected; the clarified result sentence succeeded.

Lesson: batch revised-state reads and early refusals only after checking that both finish before later proof mutations.

next_push: inspect adjacent task review tests for independent read-only CLI checks that can share one awaited batch.
layer: capabilities

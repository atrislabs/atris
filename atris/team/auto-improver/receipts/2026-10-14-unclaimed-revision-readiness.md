# Unclaimed revision readiness

Unclaimed-work revision testing now uses two app launches instead of three. The focused test and all 35 required health checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Change: production readyTask prepares unclaimed readiness with the original proof, actor and shared fixture result. The connection closes in finally before real CLI revision and claim. Every revision and claim assertion remains.

Metric: one setup launch removed, three to two (33 percent). No stable elapsed-time gain claimed.

Proof commands and actual output:

```text
node --test --test-name-pattern='^task revise returns unclaimed ready work to open so agents can claim it$' test/commands.test.js
Before: ✔ task revise returns unclaimed ready work to open so agents can claim it (442.136959ms)
After: ✔ task revise returns unclaimed ready work to open so agents can claim it (295.762084ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
exit 0 for both

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 13859.016167
exit 0
```

Brain activation and compilation returned plan-only, exit 2; no generated files were written. Requested brain and wiki index files were absent. Pre-existing lib/task-db.js, test/landing-proof.test.js and rendered TODO changes are excluded from the commit.

Task AIC-23 is in Review, not accepted. Task-ready reran the focused command, exit 0; saved proof: atris/runs/2026-10-15-task-aic-23-2026-10-15T04-29-57-861Z.json. The absolute runtime path requires second review for automatic certification. An initial landing sentence was rejected; the clarified sentence succeeded.

Lesson: unclaimed readiness can be seeded directly when revision and subsequent ownership are the behavior under test.

next_push: batch the revised-task display and stale acceptance refusal after revision, preserving the later fresh-proof readiness check.
layer: capabilities

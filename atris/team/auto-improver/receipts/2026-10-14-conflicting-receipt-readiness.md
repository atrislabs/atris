# Conflicting receipt readiness

Conflicting receipt testing now uses two app launches instead of three. The focused test and all 35 required health checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Change: prepare readiness using production readyTask, preserving actor, proof and shared fixture result. Close the store in finally before real CLI acceptance and conflicting receipt status. Every tamper, zero-reward and readable-label assertion remains.

Progress: one fewer app launch, three to two (33 percent). No elapsed-time gain claimed from one sample.

Proof commands and actual output:

```text
node --test --test-name-pattern='^xp status fails closed on conflicting duplicate receipts with readable labels$' test/commands.test.js
✔ xp status fails closed on conflicting duplicate receipts with readable labels (362.07825ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 503.10325
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 14310.880292
exit 0

git diff --check
(no output)
exit 0
```

Task AIC-20 is in Review, not accepted. The task-ready process resolves an older Node without node:sqlite, so its first verification attempt failed, exit 1. Re-running through task ready with /opt/homebrew/Cellar/node/25.6.1/bin/node passed, exit 0; saved output: atris/runs/2026-10-15-task-aic-20-2026-10-15T04-25-06-839Z.json. The absolute runtime path requires second review before automatic certification. Brain activation and compile remained plan-only, exit 2; missing generated brain files were not created. Pre-existing lib/task-db.js, test/landing-proof.test.js and rendered TODO edits remain excluded from this change.

Lesson: conflicting receipt checks need real acceptance and status reads; setup readiness can share the production store connection.

next_push: inspect local receipt tamper coverage for setup-only readiness that can use production readyTask while retaining CLI acceptance and integrity reads.
layer: capabilities

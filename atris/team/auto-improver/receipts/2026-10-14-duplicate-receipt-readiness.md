# Duplicate receipt repair readiness

Duplicate receipt repair testing now skips one setup app launch. The focused test and all required health checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Change: seed readiness through production readyTask with the original actor and proof plus the shared fixture result. Close the setup store in finally before real CLI acceptance and receipt repair. All integrity, reward, receipt count and repaired ledger assertions remain unchanged.

Progress: three app launches become two, a 33 percent reduction. No elapsed-time improvement claimed from a single sample.

Proof commands and actual output:

```text
/opt/homebrew/Cellar/node/25.6.1/bin/node --test --test-name-pattern='^xp status repairs exact duplicate local XP receipts$' test/commands.test.js
✔ xp status repairs exact duplicate local XP receipts (357.810417ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 491.006416
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 13225.121625
exit 0

git diff --check
(no output)
exit 0
```

Task AIC-19 is in Review, not accepted. The focused command ran through task ready; its saved output is atris/runs/2026-10-15-task-aic-19-2026-10-15T04-23-22-654Z.json. The absolute runtime path requires second review before automatic certification. Brain activation and compile remained plan-only, exit 2, without generated file writes. Pre-existing lib/task-db.js, test/landing-proof.test.js and rendered TODO edits were preserved and excluded from this commit.

Lesson: exact duplicate receipt repair needs real acceptance and ledger reads, while readiness can share the production setup connection.

next_push: replace setup-only readiness in the conflicting duplicate receipt test with production readyTask, retaining real acceptance and fail-closed status assertions.
layer: capabilities

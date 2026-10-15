# Accepted revision readiness

Accepted-work revision testing now uses three app launches instead of four. The focused test and all 35 required health checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Change: production readyTask prepares readiness with the original proof, actor and shared fixture result. The connection closes in finally before real CLI acceptance, refused revision and reward status. Every acceptance, rejection and reward assertion remains.

Metric: one setup launch removed, four to three (25 percent). No stable elapsed-time gain claimed.

Proof commands and actual output:

```text
node --test --test-name-pattern='^task revise refuses accepted tasks so XP is not stale$' test/commands.test.js
Before: ✔ task revise refuses accepted tasks so XP is not stale (590.066375ms)
After: ✔ task revise refuses accepted tasks so XP is not stale (465.832958ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
exit 0 for both

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 14101.238458
exit 0

git diff --check
(no output)
exit 0
```

Task AIC-22 is in Review, not accepted. Task-ready reran the focused command with /opt/homebrew/Cellar/node/25.6.1/bin/node, exit 0. Saved proof: atris/runs/2026-10-15-task-aic-22-2026-10-15T04-28-08-572Z.json. The absolute runtime path needs second review for automatic certification. The first ready request passed verification but rejected the landing sentence; a clearer result sentence succeeded. Brain activation and compilation returned plan-only, exit 2; no generated brain files were created. Some brain/index files requested by the adapter were absent. Pre-existing lib/task-db.js, test/landing-proof.test.js and rendered TODO changes are excluded from the commit.

Lesson: readiness is setup in accepted-work refusal coverage; keep acceptance, refusal and reward checks on the real CLI.

next_push: seed unclaimed revision readiness through production readyTask while keeping the real revision and subsequent claim on the CLI.
layer: capabilities

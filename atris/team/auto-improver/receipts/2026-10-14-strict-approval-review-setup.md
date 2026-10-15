# Strict approval review setup

Automatic approval testing skips one setup app launch. The focused check and all required health checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Change: the second review uses production reviewTask to attach the same proof, actor, zero reward and verification command. The connection closes in finally before the strict preview. Stored verification metadata is still asserted; every automatic approval, confirmation refusal, preview and final acceptance assertion still runs on the real CLI.

Progress: eleven app launches become ten. Single focused samples were 1261.374ms before and 1159.346792ms after, indicative only; no timing gain claimed.

Proof commands and real output:

```text
node --test --test-name-pattern='^task auto-accept-certified requires explicit human confirmation$' test/commands.test.js
✔ task auto-accept-certified requires explicit human confirmation (1159.346792ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 1299.320875
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 14539.717166
exit 0
```

Orientation: inspected saved mission state, tasks, member identity, last receipt, map and git status. Initial setup was already optimized; this change only replaces the later setup review. Existing pending lib/task-db.js, test/landing-proof.test.js and rendered TODO edits are excluded from this commit. Brain activation and compile are plan-only when no write flag is supplied.

Review: task AIC-17 is in Review, not accepted. The proof runner reran the focused check with /opt/homebrew/Cellar/node/25.6.1/bin/node and exited 0; saved proof: atris/runs/2026-10-15-task-aic-17-2026-10-15T04-20-28-358Z.json. Its absolute runtime path needs a second review because automatic certification cannot rerun it. git diff --check exited 0 with no output.

Lesson: a strict approval fixture can attach its verification command through the real review store, while the automatic approval CLI still executes and validates that command.

next_push: inspect the duplicate reward review test for a setup-only creation or ownership launch to replace with the production store.
layer: capabilities

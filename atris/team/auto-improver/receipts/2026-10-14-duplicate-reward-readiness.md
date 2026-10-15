# Duplicate reward review readiness

Duplicate reward testing skips one setup app launch. The focused check and all required health checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Change: call production readyTask on the existing fixture connection with the original actor, proof and fixture result. Close in finally before the real accept, duplicate review and XP status calls. All reward and compact-output assertions remain.

Progress: four app launches become three, a 25 percent reduction. Single focused samples were 667.67325ms before and 511.256667ms after; no timing gain claimed from single samples.

Proof commands and actual output:

```text
node --test --test-name-pattern='^task review after acceptance cannot mint duplicate AgentXP$' test/commands.test.js
✔ task review after acceptance cannot mint duplicate AgentXP (511.256667ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 650.638833
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 14220.498625
exit 0
```

Orientation: inspected mission status, tasks, identity, previous receipt, map and git status. Creation and ownership were already seeded through the store, so only readiness moved. Preserved pre-existing lib/task-db.js, test/landing-proof.test.js and rendered TODO edits, excluding them from the commit. Brain activation and compile reported plan-only, exit 2, with no generated files written.

Review: AIC-18 is in Review, not accepted. The proof-only ready call was refused because its process had not run the named command. The ready command then ran the focused test using /opt/homebrew/Cellar/node/25.6.1/bin/node and passed, exit 0. Saved artifact: atris/runs/2026-10-15-task-aic-18-2026-10-15T04-22-10-948Z.json. Absolute runtime path requires a second review before automatic certification.

Lesson: for duplicate reward protection, readiness is setup; acceptance, repeated review and ledger reads are the behavior that must stay on the real CLI.

next_push: replace setup-only readiness in the exact duplicate receipt repair test with production readyTask while preserving CLI acceptance and repair assertions.
layer: capabilities

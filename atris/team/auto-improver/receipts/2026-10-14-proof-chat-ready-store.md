The proof-derived review-chat test removes two readiness-only launches. The changed test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/TODO.md (generated task view); atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-proof-chat-ready-store.md.

Plan: seed proof readiness -> run real review-chat -> verify -> save proof.

Change: Title-only and path-only cases now call the real readyTask store operation, assert success and close the store in finally. Their review-chat calls still exercise the real CLI and retain every missing-command and artifact-path assertion. Other readiness calls that assert the ready output stay on the CLI.

Commands run:
`node --test --test-name-pattern='^task review-chat extracts only proof-derived verifier commands$' test/commands.test.js`
Baseline output: ✔ task review-chat extracts only proof-derived verifier commands (2711.273166ms); tests 1; pass 1; fail 0; exit 0.
Changed output: ✔ task review-chat extracts only proof-derived verifier commands (2389.969666ms); tests 1; pass 1; fail 0; exit 0.

Rerunnable required check:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Actual output: tests 35; pass 35; fail 0; duration_ms 10079.60825; exit 0.

Proof staging: the first ready attempt selected an older Node without node:sqlite and exited 1. Repeating the same checks with /opt/homebrew/bin/node passed, exit 0, and moved the task to Review. Saved proof: atris/runs/2026-10-14-task-aic-52-2026-10-14T22-44-48-784Z.json.

Progress: 18 launches become 16. Single-run test time fell 321ms, about 12%; this is a measurement, not a sustained speed guarantee. No production code changed.

next_push: Reduce readiness-only setup in the task ready holds work in review until human accept test while preserving CLI acceptance and review assertions.
layer: capabilities

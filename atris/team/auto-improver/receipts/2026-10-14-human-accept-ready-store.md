The human acceptance test removes one setup command launch. The changed test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/TODO.md (generated task view); atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-human-accept-ready-store.md.

Plan: seed stale guidance -> run real human acceptance -> verify -> save proof.

Change: The stale guidance side task reaches review through the real readyTask operation, with success asserted and the database closed in finally by the existing helper. Every readiness output, review, human acceptance and guidance-clearing assertion stays on the CLI. No production code changed.

Rerunnable focused check:
`node --test --test-name-pattern='^task ready holds work in review until human accept$' test/commands.test.js`
Baseline actual output: ✔ task ready holds work in review until human accept (2164.287916ms); tests 1; pass 1; fail 0; exit 0.
Changed actual output: ✔ task ready holds work in review until human accept (2109.153ms); tests 1; pass 1; fail 0; duration_ms 2240.302875; exit 0.

Rerunnable required check:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Actual output: tests 35; pass 35; fail 0; duration_ms 10245.023166; exit 0.

Progress: 16 launches become 15. The single-run test measurement fell 55ms, about 3%; the changed focused check ran alongside the required check, so elapsed time is not a controlled speed comparison. The removed process launch is the reliable progress metric.

Review proof: task readiness reran both checks with /opt/homebrew/bin/node, exit 0, and saved atris/runs/2026-10-14-task-aic-53-2026-10-14T22-46-39-902Z.json. The first proof-only readiness attempt was refused because the process had not executed the checks; no approval was bypassed. Work is in Review, not accepted.

Startup: brain activation reported plan-only, exit 2; no generated policy files were overwritten. Existing unrelated lesson and log edits were preserved.

next_push: Reduce setup-only stage launches in the explicit headless plan and do contract test while keeping stage output assertions on the CLI.
layer: capabilities

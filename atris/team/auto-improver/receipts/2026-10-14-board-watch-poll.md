The board watch test now polls its second complete redraw; 22 affected checks and all 35 required checks passed, exit 0.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerated atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-board-watch-poll.md.
Plan: launch real watch CLI -> poll second complete redraw -> stop and await child -> retain board assertions.
Verify: node --test test/member-board.test.js
Output: atris member board reads ATRIS_PROGRESS_DIR for real (3255.496125ms); tests 22; pass 22; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 5120.212583. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35; pass 35; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 9978.183625. Exit 0.
Metric: removed one fixed 3700ms subprocess timeout; successful runs stop when the second redraw completes. The real three-second refresh remains. Readiness polls every 25ms for up to eight seconds, with a ten-second child timeout as cleanup backstop. No before/after benchmark is claimed.
Lesson: observe complete output for readiness and await subprocess closure before deleting its fixture. Assert the child remained running before stopping it.
Commands: atris brain activate --root . --verify; atris; git status --short; atris mission status; atris mission goal --json; atris task list, new, claim, note, ready; both test commands above; git diff --check; atris brain compile --root .; git add, commit, push.
Brain activation returned plan-only exit 2; optional brain files and chat scan were absent. No unrelated setup files were generated.
next_push: Make the board JSON follow test parse only complete lines before polling, so split stdout chunks cannot trigger JSON parse errors.
layer: capabilities

Proof recording: task ready reran the affected checks successfully, exit 0, and saved atris/runs/2026-10-14-task-aic-8-2026-10-14T15-48-07-332Z.json. Proof is in Review without self-accept. Independent review remains pending because the installed task runner needs the absolute Node path for node:sqlite, which its automatic review cannot rerun. git diff --check passed, exit 0. Brain compile returned plan-only exit 2. Changes committed and pushed to the existing branch.

layer: capabilities

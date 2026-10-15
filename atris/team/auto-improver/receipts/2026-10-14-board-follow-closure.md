The board follow test now awaits closure safely after an early exit; 22 affected checks and all 35 required checks passed, exit 0.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerated atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-board-follow-closure.md.
Plan: real CLI child -> capture closure at spawn -> exercise snapshot and events -> stop -> await closure -> remove fixtures.
Verify: node --test test/member-board.test.js
Output excerpt: atris member board --json --follow streams one JSON object per line (158.345708ms); tests 22; pass 22; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 5012.142584. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 10454.458083. Exit 0.
Metric: removed one missed-exit-event cleanup hang; child lifetime bounded to 20 seconds, above both eight-second polling budgets combined. Existing stream assertions remain, with an added signal-state check. No speed benchmark claimed.
Lesson: subscribe to subprocess closure immediately after spawning; a cleanup-time subscription can miss an earlier event, and close also waits for output pipes to finish.
Commands: atris brain activate --root . --verify; atris; git status --short; atris mission status, goal, attach-task; atris task list, new, claim, note, ready; both test commands above; git diff --check; atris brain compile --root .; git add, commit, push.
Mission attachment returned lock busy; existing mission was preserved. Brain activation and compilation returned plan-only exit 2; unrelated generated files were not written.
next_push: Capture and await child closure in the project-filtered board follow test before parsing its final output.
layer: capabilities

Proof recording: the first ready attempt rejected result wording before running tests. The revised result passed; task ready reran the affected checks successfully, exit 0, and saved atris/runs/2026-10-14-task-aic-10-2026-10-14T15-52-36-492Z.json. Work is in Review without self-accept. Independent review remains pending because the installed task runner requires an absolute Node path for node:sqlite, outside automatic review support. git diff --check passed, exit 0. Safe-lane changes are committed and pushed to the existing branch.

next_push: Capture and await child closure in the project-filtered board follow test before parsing its final output.
layer: capabilities

The board update test now waits for complete output lines before parsing; 22 affected checks and all 35 required checks passed, exit 0.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerated atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-board-json-complete-lines.md.
Plan: real CLI stream -> complete newline-terminated output -> parse snapshot and events -> retain all existing assertions.
Verify: node --test test/member-board.test.js
Output excerpt: atris member board --json --follow streams one JSON object per line (160.348042ms); tests 22; pass 22; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 4998.602208. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 9975.079541. Exit 0.
Metric: removed one premature JSON parsing path; no timing threshold or behavior assertions were weakened. No speed benchmark claimed.
Lesson: subprocess stdout chunks are arbitrary byte groups, not complete records; the trailing fragment must wait for its newline.
Commands: atris mission status, goal; atris; git status --short; atris brain activate --root . --verify; atris task list, new, claim, note, ready; both test commands above; git diff --check; atris brain compile --root .; git add, commit, push.
Brain activation returned plan-only exit 2; no unrelated generated files were written.
next_push: Bound board follow child cleanup and await closure safely even if the child exited before cleanup began.
layer: capabilities

Proof recording: the first ready attempt rejected the result wording before running tests. The revised result passed; task ready reran the affected checks successfully, exit 0, and saved atris/runs/2026-10-14-task-aic-9-2026-10-14T15-50-15-362Z.json. Work is in Review without self-accept. Independent review remains pending because the installed task runner requires an absolute Node path for node:sqlite, outside automatic review support. git diff --check passed, exit 0. Brain compile returned plan-only exit 2.

next_push: Bound board follow child cleanup and await closure safely even if the child exited before cleanup began.
layer: capabilities

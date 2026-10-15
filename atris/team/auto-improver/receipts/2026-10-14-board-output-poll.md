The board stream test now polls complete output instead of sleeping; all five changed-surface checks and all 35 required checks passed, exit 0.

Files edited: test/member-board-this-project.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerated atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-board-output-poll.md.
Plan: spawn real CLI -> poll complete snapshot -> append updates -> poll complete event -> retain project-filter assertions.
Verify: node --test test/member-board-this-project.test.js
Output: follow stream in a project skips other projects' new lines (137.628667ms); tests 5; pass 5; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 512.952667. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35; pass 35; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 10287.212083. Exit 0.
Metric: removed one unconditional 700ms startup wait; both output waits poll every 25ms with a five-second bound. The stream case completed in 137.628667ms on this run; no before/after benchmark is claimed.
Lesson: wait for a complete snapshot before appending stream input; wait for a complete event before parsing JSON, since stdout chunks may split lines.
Commands: atris brain activate --root . --verify; atris; git status --short; atris mission status; atris mission goal --json; atris task list, new, claim, note, ready; both test commands above; git diff --check; atris brain compile --root .; git add, commit, push.
Brain activation returned plan-only exit 2; optional brain files and chat scan were absent. No unrelated setup files were generated.
next_push: Replace the board watch test's fixed 3700ms subprocess timeout with polling for its second redraw, preserving the real three-second redraw check.
layer: capabilities

Proof recording: the first ready attempt ran the checks successfully but rejected the landing sentence; the revised sentence passed. Saved task proof: atris/runs/2026-10-14-task-aic-7-2026-10-14T15-45-48-273Z.json. Task is in Review without self-accept; independent review is pending because the installed task runner needs the absolute Node path for node:sqlite. git diff --check passed, exit 0. Brain compile returned plan-only exit 2.

layer: capabilities

The project-filtered board test now waits for child closure before parsing final output; five affected checks and 35 required checks passed, exit 0.

Files edited: test/member-board-this-project.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerated atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-project-board-closure.md.
Plan: real CLI child -> capture close immediately -> poll complete events -> stop -> await close -> parse final output.
Verify: node --test test/member-board-this-project.test.js
Output excerpt: follow stream in a project skips other projects' new lines (140.93875ms); tests 5; pass 5; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 504.280084. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 10005.218959. Exit 0.
Metric: one follow child is now awaited before final output parsing; its lifetime is bounded to 15 seconds, above the two five-second readiness budgets. All filtering assertions remain. No speed benchmark claimed.
Lesson: sending a stop signal does not guarantee output pipes are drained; capture close at spawn and await it before reading the final buffer.
Commands: atris brain activate --root . --verify; atris; git status --short; atris mission status and goal; atris task list, new, claim, note, ready; both test commands above; git diff --check; atris brain compile --root .; git add, commit, push.
Brain activation returned plan-only exit 2; compiled brain source files are absent, so unrelated generated files were not written.
next_push: Clean up temporary project and progress folders created by the project-filtered board tests after their children close.
layer: capabilities

Proof recording: the first ready attempt passed the tests but rejected the landing sentence. The revised sentence passed; task ready reran the affected checks, exit 0, and moved the work to Review without self-accept. Independent review remains pending because automatic review cannot rerun the installed runner's absolute Node path. Brain compile returned plan-only exit 2. Safe-lane changes are being committed and pushed to the existing branch.
next_push: Clean up temporary project and progress folders created by the project-filtered board tests after their children close.
layer: capabilities

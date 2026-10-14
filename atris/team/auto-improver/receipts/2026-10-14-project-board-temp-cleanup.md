The project-filtered board tests now remove every temp folder they make; five affected checks and 35 required checks passed, exit 0.

Files edited: test/member-board-this-project.test.js, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-project-board-temp-cleanup.md.
Plan: one helper records each temp folder -> one after hook removes them once all tests and the follow child finish.
Verify: node --test test/member-board-this-project.test.js
Output excerpt: tests 5; pass 5; fail 0; duration_ms 506.222375. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; duration_ms 28552.004209. Exit 0.
Metric: leftover board temp folders per run went from 12 (old file, measured by running the previous version once) to 0 (count stayed at 72 before and after the new run). The 12 probe folders were removed by exact path.
Lesson: count leftovers before and after one run of the old file; it turns a cleanup claim into a number.
next_push: Add the same temp folder cleanup to test/youtube-teach.test.js, which makes 63 temp folders and removes none.
layer: capabilities

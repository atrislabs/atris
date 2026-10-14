The YouTube tests now remove every temp folder they make; 83 affected checks and 35 required checks passed, exit 0.

Files edited: test/youtube.test.js, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-youtube-temp-cleanup.md.
Plan: one helper records each temp folder -> one after hook removes them once all tests finish. All 28 creation sites route through it.
Verify: node --test test/youtube.test.js
Output excerpt: tests 83; pass 83; fail 0; skipped 0; duration_ms 373.148292. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; duration_ms 28780.109416. Exit 0.
Metric: leftover folders per run went from 91 (previous version, run once) to 0, counted with find before and after each run. 28 sites made 91 folders because shared setup helpers run in many tests (24 process, 23 notes, 22 apply). Probe folders were removed by exact path; 12,826 older leftovers remain untouched.
Lesson: count leftovers per run, not creation sites; shared setup helpers multiply the leak.
next_push: Add the same temp folder cleanup to test/youtube-watch.test.js, which makes 12 temp folders and removes none.
layer: capabilities

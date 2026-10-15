The YouTube watch tests now remove every temp folder they make; 25 affected checks and 35 required checks passed, exit 0.

Files edited: test/youtube-watch.test.js, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-youtube-watch-temp-cleanup.md.
Plan: one helper records each temp folder -> one after hook removes them once all tests finish. All 12 creation sites route through it.
Verify: node --test test/youtube-watch.test.js
Output excerpt: tests 25; pass 25; fail 0; skipped 0; duration_ms 441.493792. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; duration_ms 28471.532542. Exit 0.
Metric: leftover folders per run went from 30 (previous version, run once) to 0, counted with find before and after each run. 19 came from one shared setup helper. Probe folders were removed by exact path; 12,826 older leftovers remain untouched.
Lesson: the same helper pattern now covers four files; the remaining uncleaned files each make seven or fewer folders, so per-tick value is shrinking.
next_push: Add the same temp folder cleanup to test/loops.test.js, which makes 7 temp folders and removes none.
layer: capabilities

The YouTube teach tests now remove every temp folder they make; 75 affected checks and 35 required checks passed, exit 0.

Files edited: test/youtube-teach.test.js, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-youtube-teach-temp-cleanup.md.
Plan: one helper records each temp folder -> one after hook removes them once all tests finish. All 63 creation sites route through it.
Verify: node --test test/youtube-teach.test.js
Output excerpt: tests 75; pass 75; fail 0; duration_ms 756.35475. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; duration_ms 29045.143875. Exit 0.
Metric: leftover folders per run went from 63 (previous version, run once) to 0, counted with find before and after each run. The probe folders were removed by exact path. 12,826 older leftover folders from past runs remain and were not touched.
Lesson: a shell glob count over a huge temp folder fails with argument list too long, and hiding stderr turned that into a false zero. Count with find, and distrust a zero that contradicts the code.
next_push: Add the same temp folder cleanup to test/youtube.test.js, which makes 28 temp folders and removes none.
layer: capabilities

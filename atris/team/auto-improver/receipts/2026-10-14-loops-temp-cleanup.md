The loops tests now remove every temp folder they make; 9 affected checks and 35 required checks passed, exit 0.

Files edited: test/loops.test.js, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-loops-temp-cleanup.md.
Plan: one helper records each temp folder -> one after hook removes them once all tests finish. All 7 creation sites route through it.
Verify: node --test test/loops.test.js
Output excerpt: tests 9; pass 9; fail 0; skipped 0; duration_ms 1367.755917. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt: tests 35; pass 35; fail 0; duration_ms 28697.166. Exit 0.
Metric: leftover folders per run went from 15 (previous version, run once) to 0, counted with find before and after each run. Probe folders were removed by exact path; 821 older leftovers with these names remain untouched.
Timing scan for the next tick: required files take 2.5s (stall signal), 28.6s (prep brief), 22.6s (run record). The slowest single check is the prep stall or empty answer case at 8.0s.
Lesson: five files now clean up their temp folders; the rest each make six or fewer, so the mission's slow test focus pays more from here.
next_push: Cut the 8 second prep stall check in the roster prep brief tests by shortening its stall wait or polling, without weakening what it proves.
layer: capabilities

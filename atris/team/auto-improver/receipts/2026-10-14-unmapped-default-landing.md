Default landing setup starts one fewer command; the changed test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task-generated), atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Changed-surface proof: `node --test --test-name-pattern='task ready default landing describes completed work for unmapped titles' test/commands.test.js`
Before output: ✔ task ready default landing describes completed work for unmapped titles (538.923292ms); tests 1, pass 1, fail 0, duration_ms 676.510417. Exit 0.
After output: ✔ task ready default landing describes completed work for unmapped titles (459.902875ms); tests 1, pass 1, fail 0, cancelled 0, skipped 0, duration_ms 603.766292. Exit 0.

Required proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, duration_ms 10765.977458. Exit 0.
`git diff --check`: no output, exit 0.

Progress: one creation launch removed, from four commands to three (25%). Claim, ready and show still run the real CLI, with every landing and output assertion intact. Observed affected-test time fell by 79.020417 ms (14.7%); one sample is not a timing guarantee.
Lesson: Resolve the seeded task's display reference from the real task store and close the database before CLI claim to preserve the landing behavior without a creation launch.
Setup: clean git status, mission status, open task list, member identity, soul, latest receipt and workspace map read. Mission goal reported no candidate. Brain activation and compile returned plan-only output; missing generated files were left alone.
next_push: Replace the three creation launches in the landing capability sentence test with ordered real-store seeds while preserving claim, ready, finish and projection assertions.
layer: capabilities

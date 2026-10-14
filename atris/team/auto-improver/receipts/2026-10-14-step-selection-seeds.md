Step selection setup starts two fewer commands; the affected test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task-generated), atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Changed-surface proof: `node --test --test-name-pattern='task current picks earlier golden-path pass step over a later one touched more recently' test/commands.test.js`
Before output: ✔ task current picks earlier golden-path pass step over a later one touched more recently (690.911916ms), tests 1, pass 1, fail 0, duration_ms 847.299792. Exit 0.
After output: ✔ task current picks earlier golden-path pass step over a later one touched more recently (426.718833ms), tests 1, pass 1, fail 0, cancelled 0, skipped 0, duration_ms 562.253167. Exit 0.

Required proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, duration_ms 10585.943. Exit 0.
`git diff --check`: no output, exit 0.

Progress: two creation launches removed, from five command launches to three (40%). Both plans and current selection remain real CLI invocations; every behavior assertion remains intact. Observed affected-test time fell by 264.193083 ms (38.2%); a single sample is not a timing guarantee.
Lesson: Seed each row at its original point in the test, with ordered creation and a closed database before the next command. This keeps the later row planned more recently without adding fixed waits. The handoff mentioned a queue command, but this test has only plan and current calls.
Setup inspection: git status, mission status, task list, member identity, soul and latest receipt consulted. Brain activation and compile returned plan-only output; absent generated brain files were not created for this bounded test change.
next_push: Remove the creation launch from the certified golden-path checkpoint next-selection test, preserving claim, ready, review and next CLI checks.
layer: capabilities

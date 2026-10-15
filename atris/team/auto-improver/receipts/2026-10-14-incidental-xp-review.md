Wording review setup starts one fewer command; the changed test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task-generated), atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Changed-surface proof: `node --test --test-name-pattern='task review summary does not treat incidental XP wording as AgentXP work' test/commands.test.js`
Before output: ✔ task review summary does not treat incidental XP wording as AgentXP work (557.138125ms); tests 1, pass 1, fail 0, duration_ms 695.74375. Exit 0.
After output: ✔ task review summary does not treat incidental XP wording as AgentXP work (441.49ms); tests 1, pass 1, fail 0, cancelled 0, skipped 0, duration_ms 580.174125. Exit 0.

Required proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, duration_ms 10536.938667. Exit 0.
`git diff --check`: no output, exit 0.

Progress: one creation launch removed, from four commands to three (25%). Claim, ready and show still run the real CLI, with every summary, landing, result, proof and output assertion intact. Observed affected-test time fell by 115.648125 ms (20.8%); one sample is not a timing guarantee.
Lesson: Create the fixture through the real task store, resolve its display reference and close the database before CLI claim. This preserves wording checks without paying for an unrelated creation command.
Setup: clean git status, mission status, open task list, member identity, soul, latest receipt and workspace map read. Mission goal reported no candidate. Brain activation and compile returned plan-only output; missing generated files were left alone.
next_push: Remove the creation launch from the unmapped-title default landing test while preserving claim, ready and all landing assertions.
layer: capabilities

Existing seed selection setup starts two fewer commands; the affected test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task-generated), atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Changed-surface proof: `node --test --test-name-pattern='task next does not repeat an Endgame seed that already exists' test/commands.test.js`
Before output: ✔ task next does not repeat an Endgame seed that already exists (1231.690292ms), tests 1, pass 1, fail 0, duration_ms 1370.492666. Exit 0.
After output: ✔ task next does not repeat an Endgame seed that already exists (968.969625ms), tests 1, pass 1, fail 0, cancelled 0, skipped 0, duration_ms 1104.382542. Exit 0.

Required proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, duration_ms 9908.856833. Exit 0.
`git diff --check`: no output, exit 0.

Progress: two creation launches removed, from nine commands to seven (22.2%). Both claims, ready, review and all three next commands still exercise the real CLI, with every behavior assertion intact. Observed affected-test time fell by 262.720667 ms (21.3%); one timing sample is not a guarantee.
Lesson: Seed each real task at its original setup point, resolve its display reference, and close the store before the next command. Ordered creation preserves existing-seed selection while CLI claims and certification still test behavior.
Setup: clean git status, mission status, task list, member identity, soul and latest receipt read. Mission goal reported no candidate. Mission attachment encountered the live runner's lock; a dedicated task was created and claimed without changing mission state. Brain activation and compile returned plan-only output, exit 2; missing generated files were left alone.
Submission: the explicit Homebrew Node check passed, exit 0, and the task moved to Review. The absolute-path command is outside automatic certification, so independent review is still required. Submission receipt: atris/runs/2026-10-14-task-aic-42-2026-10-14T18-48-30-543Z.json.
next_push: Remove the creation launch in the incidental XP wording review-summary test while preserving claim, ready and show CLI assertions.
layer: capabilities

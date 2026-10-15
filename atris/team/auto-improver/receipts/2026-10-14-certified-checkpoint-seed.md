Certified checkpoint selection setup starts one fewer command; the affected test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task-generated), atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Changed-surface proof: `node --test --test-name-pattern='task next scoped by tag does not surface unrelated Endgame fallback' test/commands.test.js`
Before output: ✔ task next scoped by tag does not surface unrelated Endgame fallback (976.357459ms), tests 1, pass 1, fail 0, duration_ms 1113.945625. Exit 0.
After output: ✔ task next scoped by tag does not surface unrelated Endgame fallback (854.988291ms), tests 1, pass 1, fail 0, cancelled 0, skipped 0, duration_ms 989.576292. Exit 0.

Required proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, duration_ms 10512.964125. Exit 0.
`git diff --check`: no output, exit 0.

Progress: one creation launch removed, from seven commands to six (14.3%). Claim, ready, review and all three next commands still run for real; every behavior assertion remains intact. Observed affected-test time fell by 121.369168 ms (12.4%); a single sample is not a timing guarantee.
Lesson: The selection test needs a real open task, not the creation command. Seed it through the real store, resolve its display reference, and close the database before certification commands. No goal metadata was present on the original creation call.
Setup inspection: clean git status, mission status, task list, member identity, soul and latest receipt consulted. Brain activation and compile returned plan-only output (exit 2); missing generated brain files were not created for this bounded change.
Submission check: the task proof runner first used an older Node without node:sqlite and failed, exit 1. Re-running through `/opt/homebrew/bin/node --test --test-name-pattern='task next scoped by tag does not surface unrelated Endgame fallback' test/commands.test.js` passed, exit 0, and moved the task to Review. This absolute-path proof needs independent review because it is outside automatic certification. The normal shell uses Node 25.6.1. Receipt: atris/runs/2026-10-14-task-aic-41-2026-10-14T18-46-39-337Z.json.
next_push: Replace the two creation launches in the existing-Endgame-seed next-selection test with ordered real-store seeds, preserving certification and next commands.
layer: capabilities

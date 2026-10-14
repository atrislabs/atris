Tag filtering setup now starts two fewer commands; the affected check and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task-generated), atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Changed-surface proof: `node --test --test-name-pattern='task next and list honor tag scope before mutating tasks' test/commands.test.js`
Before output: ✔ task next and list honor tag scope before mutating tasks (987.456792ms), tests 1, pass 1, fail 0. Exit 0.
After output: ✔ task next and list honor tag scope before mutating tasks (764.845416ms), tests 1, pass 1, fail 0, duration_ms 905.223209. Exit 0.

Required proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, duration_ms 11068.43975. Exit 0.
`git diff --check`: no output, exit 0.

Progress: two creation launches removed. Claim, both next selections, both show reads and filtered list remain real CLI invocations; all behavior assertions remain intact. Observed affected-test time fell by 222.611376 ms (22.5%); one sample is not a timing guarantee.
Lesson: The previous pending-human-proof handoff actually names markdown import coverage with no creation launches, so leave that coverage intact. The nearby tag filtering check can seed ordered real-store rows and close the store before every command call without changing its behavior contract.
Setup inspection: mission status, task list, member identity, soul and latest receipt consulted. Brain activation and compile returned plan-only output; absent generated brain files were not created for this bounded test change.
next_push: Remove two creation launches from the earlier golden-path step selection test while preserving plan, current and queue command checks.
layer: capabilities

The latest-review scorecard check now launches four commands instead of five. The focused check and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface command, before and after:
`node --test --test-name-pattern='brain scorecard uses latest review episode per task' test/commands.test.js`

Before, exit 0:
✔ brain scorecard uses latest review episode per task (687.396583ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 817.005333

After, exit 0:
✔ brain scorecard uses latest review episode per task (694.055167ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 867.095667

Frozen check:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10461.727833

Metric: one fewer setup launch, total CLI launches five to four (20%). Single runtime samples show no measured speedup; there is no timing assertion. All original assertions remain. The task is seeded untagged at its original creation point; done, review, scorecard and compile still run on the real CLI. Store closes before launching commands.

Proof artifact: atris/runs/2026-10-14-task-aic-2-2026-10-14T20-04-48-980Z.json. Task ready reran both tests with /opt/homebrew/bin/node and exited 0; work is in Review and was not self-accepted. Its absolute interpreter path means automatic certification needs another review, as in the preceding increment.

Other commands: atris mission status mission-2026-10-14-continue-speeding-up-slow-te-f4a7db0c; atris mission goal --json; atris task list --status open; atris task new; atris task claim; atris task note; atris task ready; git status --short; git diff --check (exit 0); atris brain activate --root . --verify and atris brain compile --root . (both plan-only, exit 2). Missing local brain files were not generated. The inherited rendered TODO was preserved because isolated task rendering would remove unrelated inherited rows.

Lesson: a process-count reduction is a deterministic improvement even when one runtime sample is slower; record both without claiming a measured speedup. Updated downstream test line references for the eight added lines.

next_push: Seed setup-only task creation in the capabilities-check nonmutation regression, keeping before/after reads and the capabilities check on the CLI.
layer: capabilities

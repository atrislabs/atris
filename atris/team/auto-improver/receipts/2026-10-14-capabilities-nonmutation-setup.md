The capability safety check now launches four commands instead of five. The focused check and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface command, before and after:
`node --test --test-name-pattern='task capabilities-check reports contract drift without mutating task truth' test/commands.test.js`

Before, exit 0:
✔ task capabilities-check reports contract drift without mutating task truth (823.00775ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 993.671958

After, exit 0:
✔ task capabilities-check reports contract drift without mutating task truth (1009.637958ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 1418.782

Frozen check:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14456.870375

Metric: one fewer setup launch, total CLI launches five to four (20%). No measured runtime speedup is claimed. All original assertions remain; task creation keeps its title, tag and workspace, the real store closes before both CLI reads and JSON/text capability checks. Downstream test line references shifted by nine lines.

Other commands: git status --short; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-f4a7db0c; atris task list; atris mission goal --json (no candidate); atris; atris task new; atris task claim; atris task note; atris task ready; git diff --check (exit 0); atris brain activate --root . --verify and atris brain compile --root . (plan only). Missing brain files were not generated; inherited TODO preserved because isolated task rendering would remove unrelated rows. Task ready requires its own real invocation, so it reruns both checks using /opt/homebrew/bin/node, avoiding the older interpreter used by the recorder.

Proof artifact: atris/runs/2026-10-14-task-aic-3-2026-10-14T20-07-25-170Z.json. Task ready reran both checks, exit 0, and placed AIC-3 in Review without acceptance. Its absolute interpreter path requires a second review for automatic certification. The initial ready attempt required a fresh invocation; another rejected the landing sentence after passing checks, so the plain result sentence was reused and ready succeeded.

Lesson: real-store creation is sufficient setup for a nonmutation check; retain CLI before/after snapshots so task version, latest event and status invariants still exercise the actual command.

next_push: Seed setup-only task creation in the safe review-lane drain check, preserving certification and drain behavior on the CLI.
layer: capabilities

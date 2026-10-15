Landing test setup now removes six command launches; all 104 affected and required checks passed, exit 0.

Files edited: test/autoland.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, this receipt.

Change: replaced the last three task creation and claim command pairs with seedClaimedTask, using the real task store and the same builder claimant. All ready, certification, landing, and behavior assertions remain unchanged. No dependencies or mission fields changed.

Rerunnable proof command:
/opt/homebrew/Cellar/node/25.6.1/bin/node --test test/autoland.test.js test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js

Real output excerpt:
autoland tick: 0 reviews certified, 1 landed (REP-1), 0 alarms, digest sent, janitor stopped 0 missions + reaped 0 worktrees, wishes: 0 dispatched, 0 waiting on operator, 0 fulfilled, receipt atris/ru
...
e benched at error routes again once the window passes, and with no stamp at once (42.424125ms)
ℹ tests 104
ℹ suites 0
ℹ pass 104
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52832.732667
Exit 0. The frozen three-file check was included unchanged. Executed proof: atris/runs/2026-10-14-task-aic-3-2026-10-14T15-35-29-690Z.json.

Metric: six fewer CLI setup launches in three tests; zero task new or task claim setup launches remain in test/autoland.test.js. No speed claim is made from noisy wall-clock timing.

Commands run: git status --short; atris mission status mission-2026-10-14-continue-fixing-slow-or-flak-d594378f; atris task list; atris; atris mission goal --json; atris task new; atris task claim AIC-3 --as auto-improver; atris task note AIC-3; atris task ready AIC-3 with the proof command above; git diff --check; git add of the five declared files; git commit; git push origin HEAD. Read-only file inspection and Python edits accompanied these commands.

Baseline: node --test --test-name-pattern='tick certifies proof-backed reviews by re-running their check, then lands them|auto-accept-certified json includes unsafe verify blockers with a reason|loose' test/autoland.test.js passed two matching cases, exit 0, duration_ms 3376.825167. The third case title did not match; the final full check covered it.

Administration: task proof is in Review; no self-accept. Brain activate/compile --root . were plan-only, exit 2, so unrelated generated policies were not changed. Task commands regenerated the legacy TODO; restored only that generated file from the clean initial version. The first ready attempt rejected result wording before testing; the corrected result executed the proof once.

Lesson: setup-only creation and claim pairs can use the existing real-store helper without bypassing the ready and landing behavior under test.
next_push: Replace the subprocess in replaceLatestProof with an in-process real task-store metadata update while preserving tampered-proof rejection checks.
layer: capabilities

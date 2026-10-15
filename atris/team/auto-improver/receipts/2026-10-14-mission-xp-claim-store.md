# Mission proof rejection setup reduction

The proof rejection test uses four command launches instead of five. The focused real CLI check and all 35 required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Plan: CLI creation -> production store claim -> real CLI proof gates -> review and push.

Change: replace setup-only CLI claim with production taskStore.claimTask, assert success and close in finally. CLI creation, both weak-proof rejections and strong-proof success retain every assertion.

Commands and real output:
```text
node --test --test-name-pattern='^task current-step rejects bookkeeping receipts for golden-path mission XP$' test/commands.test.js
✔ task current-step rejects bookkeeping receipts for golden-path mission XP (746.811917ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 921.157209
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 12281.53575
exit 0
```

Metric: one setup subprocess removed, five launches to four (20% fewer). No matched timing baseline, so no wall-time saving is claimed.

Review: AIC-71 is ready for human review, not accepted. The ready gate initially resolved node to an older runtime without node:sqlite (exit 1); using /opt/homebrew/bin/node reran the focused check successfully (exit 0). The absolute path is outside automatic certification, so review remains pending. Its result wording also required a retry to include the plain time-saving benefit.

Upkeep: brain activation and compile were plan-only; absent generated files were left alone. Pre-existing notebook edits remain unstaged. Only this increment is committed and pushed.

next_push: Remove the setup-only ownership launch from the adjacent mission XP review-lanes test, retaining readiness, review and all acceptance gates on the CLI.
layer: capabilities

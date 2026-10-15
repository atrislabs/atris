# Mission reward proof creation setup reduction

The mission reward proof test now starts three commands instead of four. Its focused real CLI check and all 35 frozen checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-mission-reward-creation-store.md.

Plan: real store creation and ownership -> CLI weak proof refusals -> CLI strong proof success.

Change: seed task creation alongside the existing production-store ownership setup. Preserve title, tag, workspace and goal metadata; resolve the display reference through the store and close in finally. Both weak proof gates and strong proof success retain every CLI assertion. Four launches become three (25%); no elapsed-time gain is claimed.

Real command output:
```text
node --test --test-name-pattern='^task current-step rejects bookkeeping receipts for golden-path mission XP$' test/commands.test.js
✔ task current-step rejects bookkeeping receipts for golden-path mission XP (433.582167ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 567.443958
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10023.303417
exit 0
```

Task AIC-79 is in Review. The ready command reran the focused check successfully using /opt/homebrew/bin/node, exit 0. Saved proof: atris/runs/2026-10-15-task-aic-79-2026-10-15T00-45-36-729Z.json. The absolute runtime path requires separate review for certification; no self-acceptance. Brain activation and compile returned plan-only, exit 2; no policy changes were applied. Pre-existing notebook edits remain outside this commit.

Lesson: inspect previous ownership reductions before estimating savings; this increment removes one creation launch, since ownership was already in process.

next_push: Seed creation in the adjacent weak-proof review-lanes test through the production store, keeping readiness, review, queue selection and acceptance gates on the CLI.
layer: capabilities

# Stale proof routing creation setup reduction

The stale proof routing test now starts nine commands instead of ten. Its focused real CLI check and all 35 frozen checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-stale-proof-creation-store.md.

Plan: production store creation -> CLI readiness and review -> stale proof routing and approval checks.

Change: replace only task creation with addSeedTask using the original title, tag, workspace and goal metadata. Resolve the display reference through the production store and close in finally. All behavioral commands and assertions remain unchanged. CLI launches fall from ten to nine (10%); no elapsed-time gain is claimed.

Real command output:
```text
node --test --test-name-pattern='^task review lanes route stale PR proof out of human accept waiting$' test/commands.test.js
✔ task review lanes route stale PR proof out of human accept waiting (1262.252417ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 1397.815125
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10099.304416
exit 0
```

Task AIC-78 is in Review. The ready command's bare node used an older runtime without node:sqlite and failed; using /opt/homebrew/bin/node reran the focused check successfully. Saved proof: atris/runs/2026-10-15-task-aic-78-2026-10-15T00-44-05-476Z.json. The absolute runtime path requires a separate review for certification; no self-acceptance. Brain activation and compile returned plan-only, exit 2; no policy changes were applied. Pre-existing notebook edits remain outside this commit.

Lesson: preserve persisted goal and display identity while moving creation-only setup into the production store, leaving the safety behavior on the CLI.

next_push: Seed creation and ownership in the adjacent weak-proof mission reward test through the production store, retaining both rejection checks and the strong-proof success command.
layer: capabilities

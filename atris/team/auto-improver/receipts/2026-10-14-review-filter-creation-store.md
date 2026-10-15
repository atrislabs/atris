# Review queue filtering creation setup reduction

The review filtering test now starts seven commands instead of nine. Its focused real CLI check and all 35 frozen checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-filter-creation-store.md.

Plan: production store creation -> CLI readiness and review -> filtered queue and current reads.

Change: both creation-only tasks use addSeedTask with the same title, tag, workspace and goal metadata. Production display-reference mapping and finally-close match adjacent fixtures. Creation remains in its original order, with each readiness and review command in between. Every behavior assertion is retained. CLI launches fall from nine to seven (22%); no elapsed-time gain is claimed.

Real command output:
```text
node --test --test-name-pattern='^task queue filters certified review rows by continue-work and human-accept waiting state$' test/commands.test.js
✔ task queue filters certified review rows by continue-work and human-accept waiting state (1024.978542ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 1158.422542
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 9891.608792
exit 0
```

Task AIC-77 is in Review. The ready command reran the focused check successfully using /opt/homebrew/bin/node and wrote atris/runs/2026-10-15-task-aic-77-2026-10-15T00-42-28-095Z.json. Its absolute runtime path requires a separate review for certification; no self-acceptance. Brain activation and compile returned plan-only, exit 2, with no generated policy changes applied. Pre-existing notebook edits remain outside this commit.

Lesson: retain creation order around CLI transitions when replacing setup launches; filtered queue reads still prove goal scope, identities and human approval safety against persisted production state.

next_push: Seed creation in the adjacent stale proof review-lanes test through the production store, keeping review and all proof-boundary routing reads on the CLI.
layer: capabilities

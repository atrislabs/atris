# Continuation display creation setup reduction

The continuation display test now launches six commands instead of seven. The focused real CLI check and all 35 frozen checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-continuation-display-creation-store.md.

Plan: real store creation -> CLI readiness and review -> CLI current and queue reads -> clear review and inspect waiting state.

Change: seed the same title, tag, workspace and goal metadata with addSeedTask. Resolve its display reference through the production store and close in finally. All behavior assertions remain unchanged. CLI launches fall from seven to six (14%); no elapsed-time improvement is claimed.

Real command output:
```text
node --test --test-name-pattern='^task current exposes continue-work for certified review suggestions$' test/commands.test.js
✔ task current exposes continue-work for certified review suggestions (856.619792ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 985.868917
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10134.393958
exit 0
```

Lesson: production-store creation can remove setup launches while actual CLI transitions and reads verify the fixture's persisted identity and goal scope.

Task AIC-76 is in Review with a successful focused check recorded using /opt/homebrew/bin/node. Automatic certification needs a separate review because the absolute runtime path cannot be rerun by autoland. No self-acceptance. Brain activation and compile returned plan-only, exit 2; no generated policy changes were applied. Pre-existing notebook edits remain outside this commit.

next_push: Seed the two creation-only tasks in the adjacent certified review queue filtering test through the production store, retaining transitions and filtered queue reads on the CLI.
layer: capabilities

# Review cleanup creation setup reduction

The review cleanup test now starts four commands instead of five. The focused real CLI check passed and the frozen three-file check passed all 35 tests, both exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-hygiene-creation-store.md.

Plan: real store creation -> CLI readiness and review -> metadata seed -> CLI queue and continuation refusal.

Change: create the parent with addSeedTask using the same title, tag, workspace and goal metadata. Resolve the display ref through the production store and close in finally. All behavior assertions remain. Setup launches fall from five to four (20%); no matched elapsed-time improvement is claimed.

Real command output:
```text
node --test --test-name-pattern='^task review hygiene reports generic continuation debt without mutation$' test/commands.test.js
✔ task review hygiene reports generic continuation debt without mutation (596.632125ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 735.289375
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10490.752292
exit 0
```

Lesson: creation-only setup can use the same real store as production while retaining actual CLI reads and transitions that prove the persisted fixture works.

Upkeep: brain activation and compile returned plan-only, exit 2. Pre-existing notebook changes remain outside this commit. Task AIC-75 goes to Review without self-acceptance; mission configuration is unchanged.

Review gate: the first ready invocation required an explicit verifier. Its bare node command selected an older runtime without node:sqlite (exit 1). Retrying with /opt/homebrew/bin/node ran the same focused test successfully, exit 0, and moved the task to Review. The frozen check above used the working runtime and passed unchanged.

next_push: Seed creation in the adjacent current-view certified continuation test through the real store, retaining readiness, review and both current/queue reads on the CLI.
layer: capabilities

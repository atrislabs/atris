# Reward receipt test setup

The saved reward receipt test skips one setup app launch, and the focused test and all required health checks passed.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Change: creation and ownership share one production store connection, closed in finally. The original title, tag, goal metadata assertions and all readiness, acceptance, receipt collection and local status CLI assertions remain. The unrelated pending lib/task-db.js and test/landing-proof.test.js edits remain outside this commit.

Progress: five app launches become four, a 20% reduction in launches. No elapsed-time improvement is claimed without matched timing samples.

Proof commands and real output:

```text
node --test --test-name-pattern='^task accept automatically projects accepted proof into durable local XP ledger$' test/commands.test.js
✔ task accept automatically projects accepted proof into durable local XP ledger (620.511459ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 15837.91525
exit 0

git diff --check
(no output)
exit 0
```

Orientation: inspected mission status, current tasks, git status, member identity and previous handoff. Brain activation and compile returned a plan only; several generated brain inputs are absent. No generated policy files were rewritten.

Review handoff: the first ready invocation refused proof without its own execution; its rerun resolved an old Node without node:sqlite and failed. The absolute /opt/homebrew/Cellar/node/25.6.1/bin/node rerun passed, exit 0, saved atris/runs/2026-10-15-task-aic-16-2026-10-15T04-18-54-758Z.json. A plain landing sentence then moved AIC-16 to Review. The task was not accepted.

Lesson: reward receipt tests can create their goal-linked row directly without sacrificing metadata assertions or the actual acceptance and receipt CLI behavior.

next_push: compare the single-row automatic approval test's setup readiness with the production store path and remove any remaining setup-only launch.
layer: capabilities

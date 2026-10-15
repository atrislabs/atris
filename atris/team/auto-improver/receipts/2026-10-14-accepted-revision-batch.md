# Accepted revision checks together

Accepted-work revision testing now runs the refusal and reward status together. The changed test and all 35 required health checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt. Task commands also refreshed atris/TODO.md, which already had unrelated changes and was excluded from the commit.

Plan: acceptance -> [revision refusal + local reward status] -> assertions -> cleanup.

Safety: lib/task-db.js:1082 refuses done tasks before writes; commands/task.js:11338 exits before writing projections. Acceptance finishes before either child starts; both children finish before cleanup. All existing assertions remain.

Proof commands and actual output:

```text
node --test --test-name-pattern='^task revise refuses accepted tasks so XP is not stale$' test/commands.test.js
Before: pass 1, fail 0, duration_ms 641.936125; test 481.183875ms; exit 0.
After: pass 1, fail 0, duration_ms 516.319167; test 377.104083ms; exit 0.

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 15476.383208
exit 0

git diff --check
(no output), exit 0.
```

Metric: three CLI launches remain, but sequential stages drop from three to two. The single local sample is not a stable timing claim.

Notebook compilation was attempted as requested, but returned plan-only, exit 2. No generated policy files were written. Existing lib/task-db.js and test/landing-proof.test.js changes were preserved.

next_push: inspect the reward receipt test for independent collection and local status reads after acceptance.
layer: capabilities

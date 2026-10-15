# Member goal row setup investigation

The attempted setup replacement lost the displayed task link. Restored the test after two failed attempts; no speed gain shipped.

- Files tried and restored: test/commands.test.js.
- Artifact: atris/receipts/member-goal-row-investigation-2026-10-15.md.
- Check: node --test --test-name-pattern='member goal-from-mission creates a bounded goal without a human title' test/commands.test.js
- Restored output: pass 1, fail 0; exit 0.
- Required check: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
- Output: pass 12, fail 0; clean, no slop tells in 0 files; exit 0.
- Evidence: direct addTask and claimTask succeeded, but payload.task was null. Changing the goal field to metadata.goal_id did not restore the link.
- Learned: the row alone does not reproduce all effects of task add; trace the saved view before trying this replacement again.
- Metric: zero launches removed; original assertions retained.
- Stop reason: two failed attempts reached the member stop rule.
- next_push: trace the saved view needed by the member goal display before replacing its setup launch.
- layer: capabilities

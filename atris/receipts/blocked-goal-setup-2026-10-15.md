# Blocked goal setup

Removed one setup launch and retained every behavior assertion.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/receipts/blocked-goal-setup-2026-10-15.md, atris/team/auto-improver/logs/2026-10-15.md.

Focused command: node --test --test-name-pattern='member goal-from-mission stops when active mission is blocked' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0. Case time: 371.074833 ms before, 248.22325 ms after, one sample each.

Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged

Required output: tests 12, pass 12, fail 0; clean, no slop tells in 4 files; exit 0.

Metric: three CLI launches become two; every behavior assertion retained.
Learned: use the production member builder for setup when member creation is outside the behavior under test.
next_push: replace the repeated-goal history check's setup-only member creation launch with the production builder.
layer: capabilities

# Repeated goal history setup

Removed one setup launch while keeping every goal reuse and history assertion.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/receipts/repeated-goal-setup-2026-10-15.md, atris/team/auto-improver/logs/2026-10-15.md.

Focused command: node --test --test-name-pattern='member goal-from-mission does not append a duplicate history entry on every reuse tick' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0. Case time: 647.334458 ms before, 536.11475 ms after, one sample each.
Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Metric: six CLI launches become five; every behavior assertion retained.
Learned: the production member builder provides the fixture without starting another program.
next_push: replace the stopped-goal test's setup-only member creation launch with the production builder.
layer: capabilities

Required output: tests 12, pass 12, fail 0; clean, no slop tells in 4 files; exit 0.

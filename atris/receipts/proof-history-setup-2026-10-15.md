Removed one setup launch; the focused history check passed with exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md.
Command: node --test --test-name-pattern='member goal-from-mission preserves completed same-day proof history' test/commands.test.js
Output: pass 1, fail 0; exit 0.
Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Required output: tests 12, pass 12, fail 0; clean, no slop tells in 5 files; exit 0.
Metric: four CLI launches become three; focused case 426.8 ms before and 334.8 ms after, single runs.
next_push: replace the older-active-goal test member fixture launch.
layer: capabilities

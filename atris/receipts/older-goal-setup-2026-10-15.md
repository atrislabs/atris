# Older goal setup proof

Changed: removed one setup launch while retaining every goal ordering assertion.
Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
Focused command: node --test --test-name-pattern='member goal-from-mission promotes the mission goal before older active goals' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0.
Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Output: tests 12, pass 12, fail 0; clean, no slop tells in 3 files; exit 0.
Metric: five program launches become four; case time 522.179917 ms before and 423.590917 ms after in single runs.
Learned: the production member scaffold prepares this fixture while all goal ordering checks stay on real commands.
next_push: replace the score-derived goal test's member setup launch.
layer: capabilities

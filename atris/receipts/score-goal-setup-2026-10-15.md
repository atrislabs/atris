
## Score-derived goal setup improvement
Changed: removed one setup launch while retaining every goal and experiment assertion.
Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
Focused command: node --test --test-name-pattern='member goal-from-score creates the active self-improvement goal from Team score evidence' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0.
Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Output: tests 12, pass 12, fail 0; clean, no slop tells in 3 files; exit 0.
Metric: six program launches become five; single-run case time 602.256167 ms before and 502.457291 ms after.
Learned: the production member scaffold prepares this fixture while goal creation, experiments and reuse still run through real commands.
next_push: replace the member wake test's setup launch with the production scaffold.
layer: capabilities

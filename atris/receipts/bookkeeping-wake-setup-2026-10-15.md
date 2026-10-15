Changed: removed one bookkeeping wake setup launch; the focused test and all twelve required checks passed, exit 0, with zero slop.
Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
Focused command: node --test --test-name-pattern='member wake treats member-generated goals and logs as non-blocking bookkeeping' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0.
Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Output: tests 12, pass 12, fail 0; clean, no slop tells in 3 files; exit 0.
Metric: one fewer program launch; single-run case time 748.801625 ms before and 628.011292 ms after. Timing is observational.
Learned: production member scaffolding preserves the real wake checks for generated files and operator edits.
next_push: replace the scoped steering wake test's member setup launch with the production scaffold.
layer: capabilities

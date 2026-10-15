Scoped steering wake setup now skips one program launch; the focused test and twelve required checks passed, exit 0, with zero slop.
Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
Focused command: node --test --test-name-pattern='member wake can change direction from scoped steering memory' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0.
Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Output: tests 12, pass 12, fail 0; clean, no slop tells in 3 files; exit 0.
Metric: four launches become three. Observed focused case time: 641.570375 ms before, 523.055084 ms after; timing is observational.
Learned: the production member scaffold preserves both real wake calls and all steering assertions.
next_push: replace the closed-reference steering wake test setup launch with the production scaffold.
layer: capabilities

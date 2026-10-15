Continuation display reads now run together; the focused real CLI test passed with every assertion retained, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-continuation-display-reads.md.
Verify: `/opt/homebrew/bin/node --test --test-name-pattern='^task current exposes continue-work for certified review suggestions$' test/commands.test.js`.
Before output: case 816.002292 ms, pass 1, fail 0, exit 0.
After output: case 707.728958 ms, pass 1, fail 0, exit 0.
Progress: five sequential CLI stages become four, with the same five launches. Observed case time fell 13.3%; no timing threshold added.
Learned: both reads derive their output from unchanged stored rows and do not consume the saved view. The later review write and cleanup wait for both children.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Existing unrelated edits are excluded. Brain activation returned plan-only, exit 2; optional boot files were absent. Linking the existing mission to a task was busy, so this increment uses its own task record.
next_push: inspect adjacent queue filtering reads for safe batching after both fixtures are seeded.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. Brain compile returned plan-only, exit 2.
layer: capabilities

Review proof was saved after the focused check passed again with the current Node binary. The older Node selected inside the review command cannot load node:sqlite, so the saved rerun uses /opt/homebrew/bin/node.
layer: capabilities

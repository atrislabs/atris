Continuation display setup now needs one fewer program launch; the focused real CLI test passed, exit 0, with every display and review assertion retained.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-continuation-display-setup.md.
Verify: `/opt/homebrew/bin/node --test --test-name-pattern='^task current exposes continue-work for certified review suggestions$' test/commands.test.js`.
Before output: case 863.487125 ms, pass 1, fail 0, exit 0.
After output: case 758.410959 ms, pass 1, fail 0, exit 0.
Progress: six program launches become five. Observed case time fell 12.2%; no timing threshold added.
Learned: readiness can share the existing production-store connection; both review writes and all continuation display reads remain real CLI checks after the connection closes.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Existing unrelated edits were excluded. Brain activation returned plan-only, exit 2; optional boot files were absent.
next_push: batch the independent current and queue reads in the continuation display test after confirming their write behavior.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. Brain compile returned plan-only, exit 2.
layer: capabilities

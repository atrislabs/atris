Stale proof routing setup now uses eight launches instead of nine; the focused real CLI test passed with every routing and refusal assertion retained, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-stale-proof-readiness.md.
Verify: `/opt/homebrew/bin/node --test --test-name-pattern='^task review lanes route stale PR proof out of human accept waiting$' test/commands.test.js`.
Before output: case 550.939208 ms, pass 1, fail 0, exit 0.
After output: case 360.06 ms, pass 1, fail 0, exit 0.
Progress: one setup launch removed, nine launches become eight. Observed case time fell 34.6%; no timing threshold added.
Learned: readiness can use the production store, with the original verification command retained as metadata. Closing setup before child commands preserves the real review and routing checks.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Existing unrelated edits are excluded. Brain activation returned plan-only; optional boot files were absent.
next_push: inspect the adjacent weak proof review test for another setup-only launch to replace with a production-store call.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. `git diff --check` exited 0. Proof is saved for review; the focused check rerun also exited 0. Brain compile returned plan-only.
layer: capabilities

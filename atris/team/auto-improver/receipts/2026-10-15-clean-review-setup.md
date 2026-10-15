# Clean review setup

Clean review setup now uses two launches instead of five; the focused real CLI test passed with every review assertion retained, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-clean-review-setup.md.
Verify: `node --test --test-name-pattern='^task review accepts clean dry-run verifier$' test/commands.test.js`.
Before output: case 761.522917 ms, pass 1, fail 0, exit 0.
After output: case 328.774042 ms, pass 1, fail 0, exit 0.
Progress: three setup launches removed, five launches become two. Observed case time fell 56.8%; no timing threshold added.
Learned: creation, claim and readiness can share the production store connection. Closing it before review preserves the real passing and refusal checks.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Existing unrelated edits are excluded. Brain activation returned plan-only; optional boot files were absent.
next_push: inspect the adjacent proof-specific review test for a setup-only launch to replace with a production-store call.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. `git diff --check` exited 0. Saved proof moved the work to review. Brain compile returned plan-only.
layer: capabilities

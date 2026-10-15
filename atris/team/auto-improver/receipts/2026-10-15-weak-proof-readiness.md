# Weak proof review setup

Weak proof review setup now uses five launches instead of six; the focused real CLI test passed with every review and refusal assertion retained, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-weak-proof-readiness.md.
Verify: `node --test --test-name-pattern='^task review lanes block weak golden-path mission XP proof from accept$' test/commands.test.js`.
Before output: case 479.025 ms, pass 1, fail 0, exit 0.
After output: case 356.140666 ms, pass 1, fail 0, exit 0.
Progress: one setup launch removed, six launches become five. Observed case time fell 25.7%; no timing threshold added.
Learned: readiness can share the production creation connection while preserving the actor and strong proof. Closing it before review keeps refusal checks on the real CLI.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Existing unrelated edits are excluded. Brain activation returned plan-only; optional boot files were absent. Mission task attachment reported a busy lock; a separate scoped task records this change.
next_push: inspect the next review fixture for a setup-only launch that can use the production store.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. `git diff --check` exited 0. The first saved-proof attempt used an older Node and failed because node:sqlite was unavailable; repeating with `/opt/homebrew/bin/node` passed, exit 0, and moved the work to review. Brain compile returned plan-only.
layer: capabilities

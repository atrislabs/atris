# Casual launch checks

Both early launch refusals now run together, retaining every real CLI assertion. The focused check passed with exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, and this receipt.

Rerun: `node --test --test-name-pattern='^casual launch words route to the durable mission loop$' test/commands.test.js`
Before output: `✔ casual launch words route to the durable mission loop (265.046ms)`; pass 1, fail 0, exit 0.
After output: `✔ casual launch words route to the durable mission loop (180.207708ms)`; pass 1, fail 0, exit 0.
Progress: three sequential launch stages become two. The observed case time fell 32.0% in one sample; no timing assertion was added.
Learned: both JSON refusals exit before workspace entry; await both results before assertions and cleanup. The final keep check stays ordered.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Other pre-existing edits were excluded. Brain activation reported plan-only, exit 2; generated files were left alone.
next_push: inspect the five wiki help checks for safe concurrent reads with separate homes.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0; `pass 12`, `fail 0`, `✓ clean, no slop tells in 5 files`.
Review proof saved with the current Node path; the task is ready for review. Brain compilation also reported plan-only, exit 2.
layer: capabilities

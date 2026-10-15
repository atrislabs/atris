# Wiki help checks

Five wiki help checks now run together with separate home folders. Every real CLI output and no-state assertion remains, and the focused check passed with exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, and this receipt.

Rerun: `node --test --test-name-pattern='^wiki help paths print usage without scaffolding workspace state$' test/commands.test.js`
Before output: `✔ wiki help paths print usage without scaffolding workspace state (438.489875ms)`; pass 1, fail 0, exit 0.
After output: `✔ wiki help paths print usage without scaffolding workspace state (100.344625ms)`; pass 1, fail 0, exit 0.
Progress: five sequential launch stages become one. The observed case time fell 77.1% in one sample; no timing assertion was added.
Learned: help returns before any wiki worker runs, so independent reads can overlap. Await all results before assertions and cleanup.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Other pre-existing edits are excluded. Brain activation and compilation reported plan-only, exit 2; generated files were left alone.
next_push: inspect adjacent local wiki read checks for safe batching after fixture writes finish.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0; `pass 12`, `fail 0`, `✓ clean, no slop tells in 5 files`.
Review proof saved; the work is ready for review.
layer: capabilities

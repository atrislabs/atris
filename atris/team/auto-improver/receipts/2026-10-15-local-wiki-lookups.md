# Local wiki lookup checks

Two local graph reads now run together; the focused real CLI test passed with exit 0 and all assertions retained.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, and this receipt.
Rerun: `node --test --test-name-pattern='^wiki-miner wake builds wiki graph and wiki graph queries read it$' test/commands.test.js`
Before output: `✔ wiki-miner wake builds wiki graph and wiki graph queries read it (401.061834ms)`; pass 1, fail 0, exit 0.
After output: `✔ wiki-miner wake builds wiki graph and wiki graph queries read it (307.059125ms)`; pass 1, fail 0, exit 0.
Progress: four sequential CLI stages become three; one observed case was 23.4% faster. No timing assertion was added.
Learned: both graph lookups only read the saved file. Await both before later fixture writes and cleanup.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Other pre-existing edits are excluded. Brain activation reported plan-only; generated files were left alone.
next_push: inspect nearby member test setup for launches that can use the production store.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0; `pass 12`, `fail 0`, `✓ clean, no slop tells in 5 files`.
Review proof saved.
layer: capabilities

Review proof saved after rerunning with `/opt/homebrew/bin/node --test --test-name-pattern='^wiki-miner wake builds wiki graph and wiki graph queries read it$' test/commands.test.js`, exit 0. The default Node in the review runner lacked node:sqlite; using the installed Node resolved that tooling mismatch.
layer: capabilities

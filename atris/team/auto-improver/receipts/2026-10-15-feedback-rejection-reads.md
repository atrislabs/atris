# Feedback rejection reads

Both rejection reads run together with every assertion retained. The focused real CLI test passed with exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, and this receipt.

Rerun:
`node --test --test-name-pattern='^feedback rejects unknown subcommands before submit fallback$' test/commands.test.js`

Before output: `✔ feedback rejects unknown subcommands before submit fallback (189.942042ms)`; pass 1, fail 0, exit 0.
After output: `✔ feedback rejects unknown subcommands before submit fallback (95.63025ms)`; pass 1, fail 0, exit 0.

Progress: two sequential launch stages become one. Observed case time fell 49.7%; this is a single sample, with no timing assertion added. Both results settle before fixture cleanup.

Required final check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

Other edits present at start are excluded. Brain activation and compilation reported plan-only, exit 2; generated policy files were left alone.

Learned: the previous handoff's adjacent preview already had only one read; inspect actual launch dependencies before selecting the next batch.
next_push: inspect the two casual launch checks for independent reads and batch them if their fixtures stay unchanged.
layer: capabilities

Final proof output: `pass 12`, `fail 0`, `✓ clean, no slop tells in 5 files`; required final check exited 0.
Review proof saved with the current Node path because the task runner's default Node lacked the built-in SQLite module. The rerun exited 0 and moved the work to review.

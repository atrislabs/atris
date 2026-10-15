# Weak reward proof lane reads at once

- summary: The test that keeps weak mission reward proof from being approved now runs its four checks at the same time instead of one after another. Setup still goes through the app, because the ready and review steps are what put the work in front of a reviewer.
- metric: four back-to-back app launches become one parallel wait. Three local samples of the test's own time: about 2072 to 2200ms before, 1216 to 1484ms after, on a busy machine. Indicative only.
- safety: a scratch script built the same row through the app with the test's exact ready arguments, copied every database table, ran all four reads, and copied again. The copies matched. The refused approval exited nonzero with the same reason the test expects. Only the derived task summary file and the usage log were rewritten, the same as the reads batched last tick. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review lanes block weak golden-path mission XP proof from accept$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the current-step test that rejects bookkeeping receipts for mission reward work; its blocked step and its passing step may be separable.

layer: capabilities

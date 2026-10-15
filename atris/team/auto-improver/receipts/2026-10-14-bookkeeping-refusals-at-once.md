# Bookkeeping receipt refusals at once

- summary: The test that refuses a bookkeeping receipt as proof for mission reward work now runs its two refused steps at the same time. The passing step still runs after them, because it is the one that moves the work forward.
- metric: three back-to-back app launches become two waits. Three local samples of the test's own time: about 472 to 483ms before, 346 to 355ms after. Indicative only.
- safety: a scratch script built the same claimed row, copied every database table, ran both refused steps, and copied again. The copies matched, and both steps exited nonzero with the reason the test expects. Only the derived task summary file and the usage log were rewritten. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task current-step rejects bookkeeping receipts for golden-path mission XP$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: time the tests next to the mission reward tests and pick the one with the most back-to-back read-only app launches to batch.

layer: capabilities

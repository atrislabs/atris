# Certified review queue reads at once

- summary: The test that checks the queue of reviewed work waiting on a human now runs its four queue reads at the same time instead of one after another. The setup steps that carry the written explanation and the refused check stay on the app for now, as the test's own note asks.
- metric: four back-to-back app launches become one parallel wait. Three local samples each: about 1626 to 1675ms before, 1217 to 1237ms after. Indicative only.
- safety: a scratch script built a queue with one approved and one waiting row through the app, copied every database table, ran the four reads, and copied again. The two copies matched, so the reads change no task state. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task reviews gives a compact certified accept queue$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: seed the plain ready for the second-reviewer row in this same queue test through the task store, after comparing the queue built both ways.

layer: capabilities

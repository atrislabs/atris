# Review group cap reads at once

- summary: The test that checks review groups are capped for a quick human scan now runs its four queue reads at the same time instead of one after another. The last tick's full database copy already showed these queue reads change no task state.
- metric: four back-to-back app launches become one parallel wait. Three local samples each: about 1097 to 1115ms before, 728 to 734ms after. Indicative only.
- proof: `node --test --test-name-pattern='^task review groups are capped by default for human scan$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the status test that treats reviewed failures as closed for setup-only app launches and seed them through the task store.

layer: capabilities

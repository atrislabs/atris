# Long-title status reads at once

- summary: The test that checks long task titles are cut at a natural break now runs its two status reads at the same time. Setup was already seeded in the task store, and neither read changes task state, which the previous tick confirmed for the same status command.
- metric: two back-to-back app launches become one parallel wait. Three local samples each: about 426 to 431ms before, 312 to 314ms after. Indicative only.
- proof: `node --test --test-name-pattern='^task status closes long current titles at a clause$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: seed the five setup commands in the status test that separates review follow-up from waiting on a human through the task store.

layer: capabilities

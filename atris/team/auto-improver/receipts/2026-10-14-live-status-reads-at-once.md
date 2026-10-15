# Live status contract reads at once

- summary: The test that checks the live task status contract now runs its three status reads at the same time instead of one after another. Setup was already seeded in the task store, so the reads were the only app launches left, and none of them changes task state.
- metric: three back-to-back app launches become one parallel wait. Three local samples each: about 539 to 558ms before, 314 to 319ms after. Indicative only.
- safety: a scratch folder showed status reads only rewrite the same task summary file and append usage notes; the status answer is built from the task database, not from that file. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task status gives web and Swarlo a compact live contract$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: run the JSON and plain status reads at once in the adjacent long-title status test.

layer: capabilities

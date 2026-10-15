# Second-reviewer row ready through the store

- summary: The certified review queue test now writes the plain ready step for its row that still needs a second reviewer straight to the task store. The four queue reads, the written explanation row, and the refused check row still run through the app.
- metric: one fewer app launch. Three local samples each: about 1217 to 1237ms before, 1026 to 1078ms after. Indicative only.
- equivalence: a scratch script built that row once through the app and once through the store, then read the queue as data and as plain text. Both came out the same line for line, including the second-reviewer reason, with only the random task labels masked.
- proof: `node --test --test-name-pattern='^task reviews gives a compact certified accept queue$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: batch the read-only queue checks in the next review queue test, the one that caps review groups for a quick human scan.

layer: capabilities

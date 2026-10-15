# Review follow-up status setup through the store

- summary: The test that checks status separates review follow-up work from rows waiting on a human now writes its setup straight to the task store. Three ready steps and two review steps no longer start the app; the one status read the test is about still runs through the app.
- metric: six app launches become one. Three local samples each: about 1312 to 1320ms before, 321 to 323ms after. Indicative only.
- equivalence: a scratch script built the same three rows once through the app and once through the store, then read status both ways. Counts, review actions, next steps, and messages matched; the only differences were the random task labels each run generates.
- proof: `node --test --test-name-pattern='^task status separates review continue-work from human accept waiting$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: seed the setup ready and review steps in the certified accept queue test through the task store, keeping its unsafe ready refusal and queue read on the app.

layer: capabilities

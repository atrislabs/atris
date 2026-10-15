# Review lane act setup through the store

- summary: The test that checks review lane act only takes safe actions now puts three of its rows into review directly, instead of starting the app six times to do it. The first row still goes through the app, and every review lane act step the test checks still runs through the app.
- metric: eleven app launches become five. Three local samples of the test's own time: about 2182 to 2201ms before, 1077 to 1107ms after. Indicative only.
- safety: a scratch script built the three rows both ways. Task rows matched exactly. The one stored difference is a result summary the app adds to its history entry, so the script also ran the three review lane act steps on each copy. Their output and exit codes matched once task labels, ids and times were masked. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review-lane-act executes only safe drain actions and supports dry-run$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the review lane loop test, the next slowest task test at about 2 seconds, for setup rows that only need to sit in review.

layer: capabilities

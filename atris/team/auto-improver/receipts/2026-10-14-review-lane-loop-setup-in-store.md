# Review lane loop setup through the store

- summary: The test that checks the review lane loop runs only safe actions and stops before human approval now puts three of its rows into review directly, instead of starting the app six times to do it. The first row and every loop step the test checks still go through the app.
- metric: eleven app launches become five. Three local samples of the test's own time: about 2139 to 2169ms before, 1024 to 1032ms after. Indicative only.
- safety: a scratch script built the three rows both ways and ran the two loop steps the test checks on each copy. Their output and exit codes matched once task labels, ids and times were masked. The only stored differences were the result summary the app adds to its history entry and the follow-up key derived from the task id, as in the last tick. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review-lane-loop runs bounded safe actions and stops before human accept$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the second review lane act test, the one that refuses human approval rows, at about 1.85 seconds, for setup rows that only need to sit in review.

layer: capabilities

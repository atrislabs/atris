# Review lane act refusal test setup through the store

- summary: The test that checks review lane act takes safe actions and refuses rows waiting on human approval now puts two of its rows into review directly, instead of starting the app four times to do it. The first row and every review lane act step the test checks still go through the app.
- metric: eleven app launches become seven. Three local samples of the test's own time: about 1801 to 1845ms before, 1058 to 1105ms after. Indicative only.
- safety: a scratch script built the two rows both ways and ran the three review lane act steps the test checks on each copy. Their output and exit codes matched once task labels, ids and times were masked, and the refusal kept its human-only reason. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review-lane-act executes safe drain actions and refuses human accept rows$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the review lane drain test that picks a safe agent action without touching human approval rows, at about 1.7 seconds, for setup rows that only need to sit in review.

layer: capabilities

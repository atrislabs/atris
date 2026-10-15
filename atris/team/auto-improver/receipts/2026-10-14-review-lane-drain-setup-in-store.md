# Review lane drain setup through the store

- summary: The test that checks review lane drain picks a safe agent action and leaves human approval rows alone now puts its three rows into review directly, instead of starting the app six times to do it. Every drain read the test checks still goes through the app.
- metric: ten app launches become four. Three local samples of the test's own time: about 1636 to 1647ms before, 566 to 571ms after. Indicative only.
- safety: a scratch script built the three rows both ways and ran the two drain reads and the plain text drain on each copy. Their output and exit codes matched once task labels, ids and times were masked. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review-lane-drain picks safe agent action without mutating human accept rows$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the review lane drain test that skips work already given a follow-up, at about 1.65 seconds, for setup rows that only need to sit in review.

layer: capabilities

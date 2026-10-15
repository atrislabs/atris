# Follow-up drain test setup through the store

- summary: The test that checks review lane drain skips work already given a follow-up now puts its two parent rows into review directly, instead of starting the app four times to do it. Both follow-up steps, the second review, the drain, the status read and the current read still go through the app.
- metric: ten app launches become six. Three local samples of the test's own time: about 1591 to 1624ms before, 869 to 913ms after. Indicative only.
- safety: a scratch script ran the whole test sequence twice, once with the parents readied and reviewed through the app and once through the store, and compared all six app outputs after setup. All six matched once task labels, ids and times were masked. A first run showed one difference, traced to filler rows the script added in the same millisecond; spacing them a millisecond apart, as the test does, removed it. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review-lane-drain skips continue-work rows with existing follow-up children$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: run the drain, status and current reads at the end of this same test at once, after a database copy shows they change nothing.

layer: capabilities

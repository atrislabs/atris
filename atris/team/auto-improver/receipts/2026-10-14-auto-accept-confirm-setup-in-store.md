# Auto-accept confirmation test setup through the store

- summary: The test that checks auto-accept needs explicit human confirmation now puts its one row into review through the task store instead of two app launches.
- metric: two setup app launches removed. Three local samples of the test's own time: about 1990 to 2095ms before, 1519 to 1522ms after. Indicative only.
- safety: a scratch script built the row both ways and ran every later command in the test. All eight auto-accept outputs matched after hiding ids, labels and times. The task detail view differs only by a result summary the app ready step attaches, and no step in this test reads it. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task auto-accept-certified requires explicit human confirmation$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the auto-accept test that sweeps past the old twelve-row limit for its last app ready step, which is kept so the scan reads what the app writes; confirm whether that reason still holds.

layer: capabilities

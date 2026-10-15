# Auto-accept sweep test readies every row through the store

- summary: The test that checks the auto-accept sweep covers more than twelve rows now readies all twenty rows through the task store, removing its last setup app launch.
- metric: one setup app launch removed. Three samples of the test's own time in this same checkout: about 2128 to 2236ms before, 1891 to 1947ms after. Indicative only.
- safety: a scratch script built the rows both ways and ran the three parallel scans; all three outputs matched in 8 of 8 runs after hiding ids, labels and times. Without the app ready step no task summary file exists before the scans, and the parallel scans still matched every time. The review lane mission test still scans a row the app readied, so that path keeps its coverage. Fifteen repeat runs of the changed test all passed.
- correction: last tick timed the old test in a separate copy that lacks this checkout's uncommitted plain-folder git change, so its old time was inflated. Measured in this checkout, that change took the confirmation test from about 1740ms to about 1400ms, not 2030ms to 1520ms.
- proof: `node --test --test-name-pattern='^task auto-accept-certified --all sweeps past the old 12-row cap$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted. Without it this sweep test takes about 5.2 seconds, because every store claim and ready starts git; it is worth an owner landing it.
- next_push: file a task for the uncommitted change that skips git outside a repo, with this tick's 5.2 to 1.9 second measurement as evidence, so its owner can land it.

layer: capabilities

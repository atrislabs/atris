# Done-task claim suggestion ownership setup

- summary: The test that checks claiming a finished task suggests the next open one now starts the app five fewer times. The setup claims and finishes now go straight to the task store at the same points in the test, and every suggestion check still runs through the app.
- metric: eleven app launches become six. Three local samples each: about 1416 to 1515ms before, 692 to 733ms after, roughly half. Indicative only.
- why safe: each suggestion check needs the seeded task to be done or claimed first, so a seed that failed to land would fail the test.
- skipped: the natural task flow test claims on purpose, since picking up the task is the step it checks, so it stays as is.
- proof: `/opt/homebrew/bin/node --test --test-name-pattern='^claiming an already-done task suggests the next open task from the same tag, in JSON and human output$' test/commands.test.js` exit 0, 1 of 1 pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: seed the setup claims in the adjacent already-claimed suggestion test through the task store.

layer: capabilities

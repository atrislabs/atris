# XP ledger accept ownership setup

- summary: The test that checks approved work lands in the local XP ledger starts the app one fewer time. The setup claim now goes straight to the task store. Task creation stays on the app because the test checks its goal fields, and ready, approval and the XP reads still run through the app.
- metric: six app launches become five. Three local samples each: about 1391 to 1406ms before, 1136 to 1146ms after. Indicative only.
- proof: `/opt/homebrew/bin/node --test --test-name-pattern='^task accept automatically projects accepted proof into durable local XP ledger$' test/commands.test.js` exit 0, 1 of 1 pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: seed the setup claim in the next approval test after this one in test/commands.test.js through the task store.

layer: capabilities

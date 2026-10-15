# Unmapped title landing ownership setup

- summary: The default landing test for unmapped titles starts the app one fewer time. The setup claim now goes straight to the task store, and the ready and show checks still run through the app.
- metric: three app launches become two. Three local samples each: about 615 to 621ms before, 502 to 505ms after. Indicative only.
- proof: `/opt/homebrew/bin/node --test --test-name-pattern='^task ready default landing describes completed work for unmapped titles$' test/commands.test.js` exit 0, 1 of 1 pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: seed the setup claim in the next landing test after this one in test/commands.test.js through the task store.

layer: capabilities

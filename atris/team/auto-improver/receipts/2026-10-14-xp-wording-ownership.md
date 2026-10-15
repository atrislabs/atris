# XP wording review summary ownership setup

- summary: The XP wording review summary test starts the app one fewer time. The setup claim now goes straight to the task store, and the ready and show checks still run through the app.
- metric: three app launches become two. Three local samples each: about 864 to 889ms before, 510 to 669ms after. Indicative only.
- proof: `/opt/homebrew/bin/node --test --test-name-pattern='^task review summary does not treat incidental XP wording as AgentXP work$' test/commands.test.js` exit 0, 1 of 1 pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the worktree also holds an unlogged change to task claim in lib/task-db.js and test/landing-proof.test.js from before this tick. It was left untouched and not committed.
- next_push: find the next test in test/commands.test.js whose only CLI claim is setup before a CLI ready, and seed that claim through the task store.

layer: capabilities

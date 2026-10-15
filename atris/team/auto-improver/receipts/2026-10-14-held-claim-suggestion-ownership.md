# Held-task claim suggestion ownership setup

- summary: The test that checks claiming a task someone else holds never suggests a next task now starts the app once instead of twice, and it now catches a real bug. The setup claim goes straight to the task store, and a second open task in the same tag is seeded so a wrong suggestion would have something to name.
- metric: two app launches become one. Three local samples each: about 408 to 418ms before, 290 to 303ms after. Indicative only.
- catch: with the app changed to suggest on a held task, the old test still passed (exit 0) and the new test failed (exit 1). The app file was restored, and its diff is empty.
- proof: `/opt/homebrew/bin/node --test --test-name-pattern='^claiming a task that is only already_claimed \(not already_done\) never suggests a next task$' test/commands.test.js` exit 0, 1 of 1 pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: batch the read-only status and JSON checks in the next live status contract test into fewer app launches, or seed its setup claim through the task store.

layer: capabilities

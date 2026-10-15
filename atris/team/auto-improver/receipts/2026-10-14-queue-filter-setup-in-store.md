# Queue filter setup through the store

- summary: The test that filters reviewed work by "has a next step" versus "waiting on a human" now writes its two ready and two review setup steps straight to the task store. The two filtered queue reads and the filtered current read still run through the app.
- metric: seven app launches become three. Three local samples each: about 1304 to 1319ms before, 581 to 616ms after. Indicative only.
- equivalence: a scratch script built both rows once through the app and once through the store, each tied to the same parent goal, then ran all three reads. With task labels and times masked, the 6,355 lines of output matched exactly.
- skipped: the status test that treats reviewed failures as closed was already lean; its failed-finish step carries its own checks, so it stays on the app.
- proof: `node --test --test-name-pattern='^task queue filters certified review rows by continue-work and human-accept waiting state$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: seed the setup ready and review steps in the review lanes test that routes stale pull request proof away from waiting on a human, after comparing its reads built both ways.

layer: capabilities

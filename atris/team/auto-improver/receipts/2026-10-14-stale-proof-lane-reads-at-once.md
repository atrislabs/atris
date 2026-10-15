# Stale pull request proof lane reads at once

- summary: The test that keeps work with outdated pull request proof out of the "waiting on a human" lane now runs its seven reads at the same time instead of one after another. Its setup ready step runs a real check command that the plain store call cannot reproduce, so setup stays on the app.
- metric: seven back-to-back app launches become one parallel wait. Three local samples each: about 1602 to 1619ms before, 840 to 852ms after. Indicative only.
- safety: a scratch script built the same stale-proof row through the app, copied every database table, ran all seven reads, and copied again. The copies matched, and the exit codes matched the test, with only the refused step exiting nonzero. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review lanes route stale PR proof out of human accept waiting$' test/commands.test.js` exit 0, 1 of 1 pass, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: batch the read-only checks in the review lanes test that blocks weak mission reward proof from approval, after a database copy shows they change nothing.

layer: capabilities

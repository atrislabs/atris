# Follow-up drain test reads at once

- summary: The test that checks review lane drain skips work already given a follow-up now runs its last three reads at the same time instead of one after another.
- metric: three back-to-back app launches become one parallel wait. Three local samples of the test's own time: about 840 to 872ms before, 634 to 651ms after. Indicative only.
- safety: a scratch script ran the whole test sequence, copied every database table before the three reads and again after, and the copies matched. Two of the reads also rewrite the derived task summary file with a plain overwrite; these commands only fall back to reading that file when the database has no matching rows, and a bad read is caught, so overlapping writes cannot change what they report here. Fifteen repeat runs of the changed test all passed.
- proof: `node --test --test-name-pattern='^task review-lane-drain skips continue-work rows with existing follow-up children$' test/commands.test.js` exit 0, 15 of 15 repeats pass. `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exit 0, 35 of 35 pass.
- note: the unlogged task claim change in lib/task-db.js and test/landing-proof.test.js is still in the worktree, untouched and uncommitted.
- next_push: check the auto-accept test that requires explicit human confirmation, at about 1.75 seconds, for setup rows that only need to sit in review.

layer: capabilities

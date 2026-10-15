# Git skip outside repos

Claiming or readying a task in a folder outside any git repo no longer starts git; the full command tests, landing proof tests and required health tests passed, exit 0.

- files: lib/task-db.js, test/landing-proof.test.js, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.
- change: the commit lookup used at claim and ready first walks up from the task folder looking for a .git entry or a bare repo folder, and honors GIT_DIR. With none found it returns no commit without launching git, which is what the failed launch returned before. Inside any repo or worktree nothing changes.
- regression proof: with the old store code the new test saw two git launches (`rev-parse HEAD` at claim and at ready), fail 1; with the change, zero launches, pass 1.
- metric: full command tests 437 of 437 in 238.46 seconds wall time with the change, against 262.6 seconds without it recorded on the backlog task (single samples, not a stable timing claim).
- landing proof command: `node --test test/landing-proof.test.js`: tests 18, pass 18, fail 0, exit 0.
- command tests: `node --test test/commands.test.js`: tests 437, pass 437, fail 0, exit 0.
- frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`: tests 35, pass 35, fail 0, exit 0.
- map: two store refs that sit past the new helper moved by 16 lines (claim and release). Other task store refs were already drifted before this change and are left for a doc health pass.
- slop: `atris slop detect lib/task-db.js` clean.
- next_push: run doc health ref repair for the already drifted task store refs in the map notes, then return to setup-only launches in test/commands.test.js.

layer: environment

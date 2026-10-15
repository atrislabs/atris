# Revision setup readiness

Revision testing now starts one fewer app; the focused revision test and all required health checks passed, exit 0.

- files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md; member log: atris/team/auto-improver/logs/2026-10-14.md.
- change: initial readiness shares the production task-store connection, with the original proof and actor, asserted success and finally cleanup. Repeated readiness and all revision behavior checks remain real CLI invocations.
- metric: six app launches become five. Focused local sample: 687.085333ms before, 551.417375ms after; this is not a stable timing claim.
- focused proof: `node --test --test-name-pattern='^task revise sends ready work back to claimed with revision count$' test/commands.test.js`
- focused output: tests 1, pass 1, fail 0, exit 0.
- frozen proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
- frozen output: tests 35, pass 35, fail 0, duration_ms 13366.512042, exit 0.
- learned: seed only the initial readiness so the repeated-ready CLI still exercises review-count behavior before revision clears its evidence.
- next_push: inspect duplicate receipt repair setup for a removable setup-only CLI launch while retaining acceptance and repair checks.
- unrelated work: existing lib/task-db.js, test/landing-proof.test.js, TODO and earlier log edits remain untouched by staging.

layer: capabilities

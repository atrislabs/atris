# Lineage reads run together

Three independent lineage reads now run together; four focused changed runs and all 35 required checks passed, exit 0.

- Task: AIC-8
- Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.
- Change: use the existing async CLI helper for text, JSON and alternate-home reads after setup closes. All original assertions remain. Three sequential process turns become one, same three real CLI launches.
- Safety: commands/task.js:11796 reads task projection and git history, without task mutations or shared output files. Each child has its own environment. Cleanup waits for every result.
- Focused command: `node --test --test-name-pattern='^task lineage$' test/commands.test.js`
- Before wall milliseconds: [646, 626, 624, 634], all exit 0.
- After wall milliseconds: [393, 399, 376, 376], all exit 0.
- Metric: mean 632.5ms before, 386ms after, 39.0% less in this small local sequential sample.

Actual focused output, final run:
```text
✔ task lineage (189.171208ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 317.137625
exit 0
```

Required command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Actual output excerpt:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 12987.433667
exit 0
```

Bookkeeping commands: git status --short; atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris mission goal --json (no candidate); atris task list --status open; atris task current --json; atris task new; atris task claim AIC-8 --as auto-improver; atris task note AIC-8; git diff --check; atris task ready AIC-8; atris brain compile --root .; git add (declared files); git commit; git push.
Brain commands returned plan-only exit 2; generated optional brain files are absent. Existing changes in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md remain excluded. Readiness uses /opt/homebrew/bin/node to avoid the login shell selecting unsupported Node 20.

next_push: overlap the JSON and text reads in the long-title status test after its claim completes.
layer: capabilities

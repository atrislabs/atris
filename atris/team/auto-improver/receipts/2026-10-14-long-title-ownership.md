# Long-title status ownership setup

The long-title status test uses the real store for ownership setup; four focused runs and all 35 required checks passed, exit 0.

- Task: AIC-9
- Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.
- Change: seed ownership in the existing production-store connection. Preserve both sequential status CLI calls and every status assertion. Remove the unused display-reference lookup.
- Safety finding: status writes a shared projection, so the proposed concurrent reads were rejected during inspection. No runtime behavior changes.
- Focused command: `node --test --test-name-pattern='^task status closes long current titles at a clause$' test/commands.test.js`
- Before wall milliseconds: [636, 617, 611, 577], all exit 0.
- After wall milliseconds: [479, 498, 492, 475], all exit 0.
- Metric: three CLI launches become two; mean 610.25ms before, 486.00ms after, 20.4% less in a small sequential local sample.

Actual final focused output:
```text
✔ task status closes long current titles at a clause (281.454709ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 416.14025
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
ℹ duration_ms 14464.550625
exit 0
```

Bookkeeping: git status --short; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris brain activate --root . --verify (plan only); atris; atris mission goal --json (no candidate); atris task list --status open; atris task current --json; atris task new; atris task claim AIC-9 --as auto-improver; atris task note AIC-9; git diff --check; atris task ready AIC-9; atris brain compile --root .; git add declared files; git commit; git push.
Missing optional brain context files were reported by cat. Existing edits in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md remain excluded.

next_push: inspect live-status fixture ownership setup for a removable claim launch while preserving status CLI coverage.
layer: capabilities

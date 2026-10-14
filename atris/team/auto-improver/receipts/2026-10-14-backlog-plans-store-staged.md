The backlog cleanup test now stages two setup plans through the real task store. The changed test passed, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Change: Initial single-row and delegated-row plan setup now calls stageTask. Creation order, explicit delegated owner, goal, exit and required proof are preserved. The CLI automatic plan trace and projection are not seeded, because these setup rows test cleanup state, not automatic planning. Real delegation, both replans, backlog, clear-plan, rejection paths and every cleanup assertion remain on the CLI. No product code or dependencies changed.

Metric: CLI launches reduced from 21 to 19. One same-environment baseline measured 2581.290333ms; one changed run measured 2317.092125ms, about 264ms or 10% less. Single-run timings are directional, not a stability guarantee.

Commands and real output:
`PATH=/usr/bin:/bin:/opt/homebrew/bin node --test --test-name-pattern='^task backlog and clear-plan demote only planned open tasks$' test/commands.test.js`
Baseline: pass 1, fail 0, duration_ms 2743.248292, exit 0.
Changed: task backlog and clear-plan demote only planned open tasks (2317.092125ms); tests 1; pass 1; fail 0; duration_ms 2455.595292; exit 0.
This launches the real backlog and clear-plan CLI against SQLite fixtures.

`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35; pass 35; fail 0; duration_ms 11075.441916; exit 0.

Other commands: atris brain activate --root . --verify; atris brain compile --root . (both plan-only, exit 2, no writes); atris; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-f4a7db0c; atris mission goal --json; atris task list --status open; atris task current; atris task new; atris task claim; atris task note; git status; git diff.

Lesson: Use the existing stageTask setup pattern when the assertion targets cleanup. Keep CLI replans that prove fallback goal behavior, and preserve explicit owner assignment when staging delegated fixtures.
next_push: Reduce setup-only launches in the proof-derived review-chat test, currently the slowest measured commands check with plain git.
layer: capabilities

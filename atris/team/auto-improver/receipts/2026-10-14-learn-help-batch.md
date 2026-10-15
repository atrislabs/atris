Learn-help checks now run together; the focused test and required health tests passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.
Plan: three independent help reads -> unchanged assertions -> focused and frozen proof.
Safety: commands/learn.js:552 returns before workspace discovery. All output and no-state assertions remain, and all successful reads finish before cleanup.

Rerun the changed surface:
node --test --test-name-pattern='^learn help prints usage without workspace state$' test/commands.test.js
Before output: ✔ learn help prints usage without workspace state (1954.591458ms); tests 1, pass 1, fail 0; exit 0.
After output: ✔ learn help prints usage without workspace state (1700.055791ms); tests 1, pass 1, fail 0; duration_ms 2543.180833; exit 0.

Frozen verifier:
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0; duration_ms 105474.639625; exit 0.

Metric: three sequential waiting stages become one; all three real CLI launches and all assertions remain. The timing samples do not establish a stable speedup.
Workspace commands: atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris mission goal --json; atris task list --status open; git status --short --branch; atris task new/claim/note/ready; atris brain compile --root .; git diff --check; git commit; git push.
Brain commands reported plan only, exit 2; generated policy files were not written. No native goal candidate was returned. Existing TODO and log changes are preserved and excluded from staging; only this increment's log entry is staged.
next_push: inspect the learn command fixtures for a setup-only launch that can use the production store.
layer: capabilities

# Bulk approval previews run together

The bulk approval scan test now runs its three previews together. The focused test passed five times and all 35 required checks passed, exit 0.

## Change

- test/commands.test.js: only the bulk approval scan test becomes async; three preview commands overlap after the last ready command. All existing assertions remain.
- atris/MAP.md and atris/refs/MAP-NOTES.md: record the route and shift later command-test line references by the five added lines.
- atris/team/auto-improver/logs/2026-10-14.md: record the result and handoff.
- This receipt is the saved proof artifact.

## Proof

Rerun the changed surface:
```sh
node --test --test-name-pattern='^task auto-accept-certified --all sweeps past the old 12-row cap$' test/commands.test.js
```
Output excerpt from the last run:
```text
✔ task auto-accept-certified --all sweeps past the old 12-row cap (501.791208ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```
Exit 0 in five of five changed runs. Real CLI calls still check the default scan, all 20 rows, and the explicit five-row limit.

Required check:
```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 13995.461625
```
Exit 0.

Task proof was moved to review with the focused test through `atris task ready --verify`, exit 0. It reran with `/opt/homebrew/bin/node` to preserve Node 25 under the proof shell. Receipt: `atris/runs/2026-10-15-task-aic-1-2026-10-15T02-25-22-217Z.json`. No task was self-accepted.

## Measurement and limits

Baseline mean: 843.122ms. Changed mean: 503.339ms. Reduction: 339.783ms, about 40%. Five baseline runs followed by five changed runs, not interleaved. Both measured with the same pre-existing, uncommitted task-store optimization and landing-proof test changes. Those files are preserved and excluded from this commit; the full command suite was not rerun.

Preview handlers build their own projection from the database. They may rewrite the same projection file but do not consume another preview's file. Dry-run returns before task acceptance or reward writes. The trusted fixture has no runnable verifier.

Raw timings in milliseconds:
{
  "baseline_ms": [
    830.840041,
    820.537333,
    882.4915,
    835.330417,
    846.4105
  ],
  "changed_ms": [
    502.373667,
    497.273667,
    528.771625,
    486.484125,
    501.791208
  ],
  "baseline_mean_ms": 843.1219582,
  "changed_mean_ms": 503.33885840000005
}

## Lesson

When setup is already cheap, independent preview commands still cost process startup in sequence. Check their database and file reads before overlapping them, since a preview can write a display file.

next_push: reuse one task-store connection for the twenty bulk-test setup rows, closing before the final ready CLI call.
layer: capabilities

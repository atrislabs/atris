# Sync preview message setup

Sync preview testing uses one command launch instead of two; the focused test and all 35 frozen health checks passed, exit 0.

## Files and change

- `test/commands.test.js`: replace setup-only CLI say with production noteTask, assert success, retain the original actor and content, and seed readiness in the same connection after the note. Close in finally before the real sync CLI check. Every sync assertion remains.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: refresh sync setup description and touched review reference.
- `atris/team/auto-improver/logs/2026-10-14.md`: append evidence and handoff, preserving previous unsaved entries.
- `atris/team/auto-improver/receipts/2026-10-14-sync-preview-message.md`: this receipt.

## Proof

Command: `node --test --test-name-pattern='^task sync dry-run maps local tasks to canonical cloud task writes$' test/commands.test.js`

Before, exit 0:
```text
✔ task sync dry-run maps local tasks to canonical cloud task writes (297.366209ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```
After, exit 0:
```text
✔ task sync dry-run maps local tasks to canonical cloud task writes (174.396584ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 307.420625
```

Command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 14591.145792
```

`git diff --check`: exit 0, no output.

Metric: two CLI launches become one. One connection replaces two. Timing samples are individual observations, not a stable speedup claim.

Review: cmdNote delegates to the same production noteTask. Message content and actor match, the message precedes readiness, and sync reads committed state after close. Existing note/show/export CLI coverage remains unchanged. No production code or dependencies changed.

Context: initial status had unsaved TODO and member log changes, preserved. Brain activation and compile offered a plan only, exit 2, without writing files. No mission fields changed. No second slice was started. Task readiness passed with the absolute Node path, which requires separate review; no self-accept was performed. The first readiness attempt ran the test successfully but rejected the landing wording, which was then clarified.

next_push: inspect the task projection lineage fixture for a setup-only readiness launch that can use the production store while retaining finish and export CLI assertions.

layer: capabilities

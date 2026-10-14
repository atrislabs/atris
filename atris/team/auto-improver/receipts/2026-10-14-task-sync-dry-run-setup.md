The task sync dry-run check now uses four launches instead of five; the focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-task-sync-dry-run-setup.md.

Rerunnable verification command:
`node --test --test-name-pattern='task sync dry-run' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
test/commands.test.js exit=0 ✔ task sync dry-run maps local tasks to canonical cloud task writes (793.251334ms) ℹ pass 1 ℹ fail 0
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: one creation-only CLI launch removed, five to four. Three runs each against the previous version of the file: about 0.88s before, about 0.80s after. The real store keeps the title, swarlo tag and workspace root, asserts insertion, and closes before the CLI claim. The create command stores nothing else without flags, and no init runs, so no stale task snapshot can shadow the seeded task. Claim, say, ready and every sync plan assertion are unchanged.

Refs: the edit added 8 lines, and doc-health reported nothing to move. A small script shifted the 28 test refs below the edit by 8 after checking each moved line still holds the same text. Many of those refs already pointed mid-test before today; the shift keeps them where they were and does not fix that older drift.

Commands and artifacts: atris atris.md; git log/show; read of the create handler; focused test; timing of old and new versions; frozen verifier; atris doc-health --fix-refs; atris doc-health; atris slop detect atris/refs/MAP-NOTES.md (clean); task new/claim/ready.

Lesson: only three task new launches remain, and two are the deliberate creation coverage plus the TODO render check. Further launch cuts need a different target, such as task add or repeated claim and ready setup.

next_push: Repoint the older test refs in the map notes that land mid-test so each one names its test line again, then return to cutting repeated setup launches.
layer: capabilities

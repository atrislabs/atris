Status wording setup now uses three launches instead of four; the focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-long-title-status-setup.md.

Rerunnable verification command:
`node --test --test-name-pattern='task status closes long current titles at a clause' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran using /opt/homebrew/bin/node, exit 0. Actual output excerpt:
```text
✔ task status closes long current titles at a clause (436.075875ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 579.437417
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 9657.7385
```

Metric: one creation-only CLI launch removed, four to three (25%). Baseline focused duration 736.486584ms; after 579.437417ms. Single samples do not establish a stable timing gain. The real store preserves title, tag, creation point and display ref, closes before CLI use, and all claim and JSON/text status assertions remain intact.

Commands and artifacts: git status --short; atris; mission status; mission goal --json (no candidate); task list/new/claim/note/ready; baseline focused test; combined verification above; git diff --check; git diff; brain activate --root . --verify and brain compile --root . (both plan only); git add/commit/push. Task AIC-15 is in Review, never self-accepted. Saved proof reran the same commands and passed, exit 0: atris/runs/2026-10-14-task-aic-15-2026-10-14T20-31-23-568Z.json. The first ready call rejected prose proof because it had not run the named tests itself; ready with --verify produced the receipt. The absolute runtime path requires review before automatic acceptance. Generated TODO changes restored to the initial tracked rendering, task truth remains in the database. Optional activation files were absent. No mission fields, dependencies or production code changed.

Lesson: the prior handoff named natural flow setup, but that test explicitly covers creation. Keep creation on the CLI wherever it is asserted behavior; select an adjacent fixture-only creation instead.

next_push: Replace only the three creation-only launches in the live task status projection fixture, retaining its full JSON status assertions.
layer: capabilities

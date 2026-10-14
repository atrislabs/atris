# Duplicate receipt repair setup claim uses the store

The duplicate receipt repair test now launches three commands instead of four. Its focused check and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt. Task commands refreshed atris/TODO.md. Inherited notebook changes remain unstaged.

Plan: store creation -> store claim -> CLI readiness -> CLI acceptance -> CLI receipt repair.

Production claimTask seeds ownership in the existing setup connection, asserts success and closes before the CLI runs. All integrity, XP, receipt count and repaired ledger assertions remain unchanged. No production code changed.

Rerun commands:
```sh
node --test --test-name-pattern='^xp status repairs exact duplicate local XP receipts$' test/commands.test.js
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```

Actual output excerpts, each exit 0:
```text
✔ xp status repairs exact duplicate local XP receipts (3430.051584ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 4459.867375

ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 52205.326917
```

Metric: four to three CLI launches, one fewer (25%). No wall-clock speed claim is made from a single loaded-computer run.

Other commands: atris mission status/goal, atris task list/new/claim/note/ready, git status/log/remote/diff, git diff --check, git add/commit/push. Brain activate and compile returned plan-only exit 2 and made no edits. The readiness gate first failed with its older Node lacking node:sqlite (exit 1), then passed using /opt/homebrew/bin/node (exit 0), saving atris/runs/2026-10-14-task-aic-63-2026-10-14T23-09-25-105Z.json. Absolute-path checks require independent review before acceptance. Work goes to Review, never self-accepted; this internal change is committed and pushed under the user's standing authorization.

Lesson: Replace unused setup claim output with the production claim operation; retain the real repairing command and saved-file assertions.

next_push: Remove the setup-only claim launch in the conflicting duplicate receipt test while retaining the real fail-closed XP status checks.
layer: capabilities

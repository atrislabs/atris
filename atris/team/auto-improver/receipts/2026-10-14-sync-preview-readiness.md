# Sync preview readiness setup

Sync preview testing uses two command launches instead of three; the focused test and frozen health checks passed, exit 0.

## Change

- `test/commands.test.js`: readiness uses production `readyTask` with the original actor, proof and fixture result after the CLI message. Both store connections close in finally; the sync dry-run and all assertions remain on the CLI.
- `atris/MAP.md`: refresh sync fixture setup description.
- `atris/refs/MAP-NOTES.md`: refresh sync setup and shifted review fixture reference.
- `atris/team/auto-improver/logs/2026-10-14.md`: append this increment's evidence and handoff, preserving earlier unsaved entries.
- This receipt is the proof artifact.

## Real-surface proof

Command: `node --test --test-name-pattern='^task sync dry-run maps local tasks to canonical cloud task writes$' test/commands.test.js`

Before, exit 0:
```text
✔ task sync dry-run maps local tasks to canonical cloud task writes (422.494583ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```
After, exit 0:
```text
✔ task sync dry-run maps local tasks to canonical cloud task writes (283.0815ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 13969.59525
```

Metric: setup removes one of three CLI launches. Single timing samples do not establish a stable speedup.

Review: verified original proof, actor and fixture result match the CLI helper defaults; message still precedes readiness, and sync reads committed store state after close. No production code or dependencies changed.

Review handoff: the first ready invocation rejected result wording; the second used an older Node without SQLite and failed before tests. Repeating with `/opt/homebrew/bin/node --test --test-name-pattern='^task sync dry-run maps local tasks to canonical cloud task writes$' test/commands.test.js` passed, exit 0, and moved the task to Review. This absolute-path proof requires separate review; no self-accept was performed.

Context: initial status had unsaved TODO and member log changes; preserve them. Brain activation and compile were invoked but only offered a plan, with no files written. No mission fields changed.

next_push: replace the sync preview fixture's setup-only message launch with the production dialogue store call, preserving message-before-readiness order and every sync assertion.

layer: capabilities

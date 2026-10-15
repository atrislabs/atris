# Human review fallback setup

The fallback test uses one fewer app launch; its focused test and all 35 required checks passed, exit 0.

Files edited: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Change: claim through production `taskStore.claimTask` in the creation connection, assert success, and close in finally before CLI calls. Every certification, selection, follow-up creation and show assertion remains unchanged. No product code changed.

Metric: eight CLI launches become seven. One local before sample: 1146.674292ms; after: 1012.309667ms, about 12% less. Single samples are indicative only.

Rerunnable focused command (run before and after):
`node --test --test-name-pattern='^task next surfaces Endgame fallback for human-only certified review$' test/commands.test.js`

Actual after output:
```text
✔ task next surfaces Endgame fallback for human-only certified review (1012.309667ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1153.791167
exit 0
```

Frozen command:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Actual output excerpt:
```text
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14279.084375
exit 0
```

Other commands: git status --short; atris brain activate --root . --verify; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris; atris mission goal --json (no candidate); atris task list --status open; atris task new; atris task claim AIC-12 --as auto-improver; atris task note AIC-12; git diff --check (exit 0); atris brain compile --root . (exit 2, plan only). Brain source files are absent, so no unrelated scaffolding was generated. Existing edits in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md are excluded from this change.

Review handoff: the proof-only command was refused because the task command requires its own execution record. Retried with `atris task ready AIC-12 --verify` using `/opt/homebrew/bin/node` and the focused arguments above; exit 0, task in Review. Proof artifact: `atris/runs/2026-10-15-task-aic-12-2026-10-15T02-49-07-865Z.json`. Automatic acceptance is gated because the absolute Node path is outside its allowlist. Saved with git add of the five declared files, git commit, and git push origin HEAD.

Lesson: ownership is setup in fallback selection coverage; seed it through the real store while preserving the CLI certification and selection path.

next_push: replace setup-only ownership in the adjacent tag-scoped certified checkpoint selection test with a production store call.
layer: capabilities

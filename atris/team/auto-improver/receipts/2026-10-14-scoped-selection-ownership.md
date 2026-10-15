# Scoped selection setup

The scoped selection test uses one fewer app launch; its focused test and all 35 required checks passed, exit 0.

Files edited: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Change: claim through production `taskStore.claimTask` in the creation connection, assert success, and close in finally before CLI calls. Every readiness, certification, scoped text/JSON selection and follow-up refusal assertion remains unchanged. No product code changed.

Metric: six CLI launches become five. One local before sample: 853.955875ms; after: 755.68775ms, about 12% less. Single samples are indicative only.

Rerunnable focused command (run before and after):
`node --test --test-name-pattern='^task next scoped by tag does not surface unrelated Endgame fallback$' test/commands.test.js`

Actual after output:
```text
✔ task next scoped by tag does not surface unrelated Endgame fallback (755.68775ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 899.639458
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
ℹ duration_ms 14880.518125
exit 0
```

Other commands: git status --short; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris task list --status open; atris brain activate --root . --verify (plan only); atris mission goal --json (no candidate); atris task current; atris task new; atris task claim AIC-13 --as auto-improver; atris task note AIC-13; atris brain compile --root . (exit 2, plan only). Brain source files are absent, so no unrelated scaffolding was generated. Existing edits in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md are excluded from this change.

Review handoff: `atris task ready AIC-13 --verify` reran the focused command with `/opt/homebrew/bin/node`, exit 0, and moved the task to Review. Proof artifact: `atris/runs/2026-10-15-task-aic-13-2026-10-15T02-50-50-059Z.json`. Automatic acceptance remains gated because the absolute Node path is outside its allowlist. `git diff --check` passed, exit 0. Shipping commands: git add of the five declared files, git commit, git push origin HEAD.

Lesson: ownership is setup in scoped selection coverage; use the real store and retain the CLI path for certification and selection.

next_push: seed the existing-seed owner's setup claim through the production store in the adjacent duplicate Endgame selection test.
layer: capabilities

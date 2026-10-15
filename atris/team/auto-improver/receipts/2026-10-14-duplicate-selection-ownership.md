# Duplicate selection ownership setup

The duplicate-selection test uses one fewer app launch; its focused test and all 35 required checks passed, exit 0.

Files edited: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Change: fixture creation accepts an optional owner and calls production claimTask, asserting success before closing in finally. Only the existing seed ownership launch is removed. Checkpoint claim, readiness, certification, text/JSON selection and duplicate refusal remain CLI invocations with every original behavioral assertion.

Metric: seven CLI launches become six. Before sample: 974.724583ms; after: 834.235834ms, about 14% less. Single samples are indicative only; the launch reduction is structural.

Rerunnable surface command:
`node --test --test-name-pattern='^task next does not repeat an Endgame seed that already exists$' test/commands.test.js`

Actual output:
```text
✔ task next does not repeat an Endgame seed that already exists (834.235834ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 970.466291
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
ℹ duration_ms 13214.881
exit 0
```

Commands and artifacts: git status --short; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris; atris brain activate --root . --verify (plan only); atris mission goal --json (no candidate); atris task list --status open; atris task new; atris task claim AIC-14 --as auto-improver; atris task note AIC-14; atris brain compile --root . (plan only). Referenced brain files are absent; no unrelated scaffolding generated.

Review handoff: the first `atris task ready AIC-14 --verify` used PATH Node and failed with ERR_UNKNOWN_BUILTIN_MODULE for node:sqlite, exit 1. Corrected command used `/opt/homebrew/bin/node --test --test-name-pattern='^task next does not repeat an Endgame seed that already exists$' test/commands.test.js`, exit 0, moving the task to Review. Proof artifact: `atris/runs/2026-10-15-task-aic-14-2026-10-15T02-52-25-117Z.json`. Automatic acceptance remains gated because the absolute Node path is outside its allowlist. No self-acceptance.

Shipping: git diff --check, exit 0; git add of the five declared files; git commit; git push origin HEAD. Existing lib/task-db.js, test/landing-proof.test.js and atris/TODO.md changes excluded.

Lesson: seed existing ownership through the production store for duplicate selection tests, keeping checkpoint and refusal behavior on the CLI. Use the explicit modern Node path for task proof because its subprocess PATH selects older Node.

next_push: seed setup-only ownership in the adjacent incidental XP wording review-summary test through the production store.
layer: capabilities

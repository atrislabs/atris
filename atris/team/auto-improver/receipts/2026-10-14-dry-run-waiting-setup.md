Waiting-for-human safety setup now launches thirteen commands instead of fourteen; the focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-dry-run-waiting-setup.md.

Actual verification command, exit 0:
`/opt/homebrew/bin/node --test --test-name-pattern='task review-lane-act executes only safe drain actions and supports dry-run' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Actual output excerpt:
```text
✔ task review-lane-act executes only safe drain actions and supports dry-run (2024.0355ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 2169.78575
✔ an engine benched at error routes again once the window passes, and with no stamp at once (44.521583ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10403.636791
```

Metric: one fewer CLI launch, fourteen to thirteen (7.1%). Baseline focused duration 2334.499791ms; after 2169.78575ms. Single samples do not establish a stable speedup. Real-store creation preserves title, tag, goal link and creation point; closes before readiness; leaves every CLI action and unchanged version/event assertion intact.

Proof artifact: atris/runs/2026-10-14-task-aic-13-2026-10-14T20-26-56-234Z.json. Task AIC-13 is in Review, never self-accepted. The task proof rerun passed, exit 0; its absolute Node path is outside the automatic rerun allowlist, so approval still needs review. Mission fields and verifier were not changed.

Commands and artifacts: git status --short; mission status; atris; brain activate --root . --verify; mission goal --json (no candidate); task list/new/claim/note/ready; baseline focused test; combined verification command above; git diff --check; git diff; brain compile --root . (plan only); git add/commit/push. The first ready call rejected its result wording without updating readiness; the revised plain result passed. Generated TODO changes restored to the initial clean version, leaving task truth in the database. Map references after the edit shifted four lines.

Lesson: replace creation-only setup through the real store at the original point, while human approval protection remains exercised by the real CLI. Count removed launches separately from noisy timings.

next_push: Inspect the next review-loop test for a remaining creation-only CLI launch and replace only that setup while preserving its bounded-action and human approval assertions.
layer: capabilities

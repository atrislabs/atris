Dry-run safety setup now launches fourteen commands instead of fifteen; the focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-dry-run-human-approval-setup.md.

Actual verification command, exit 0:
`/opt/homebrew/bin/node --test --test-name-pattern='task review-lane-act executes only safe drain actions and supports dry-run' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Actual output excerpt:
```text
✔ task review-lane-act executes only safe drain actions and supports dry-run (2057.626916ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2192.971375
✔ the r
...
engine benched at error routes again once the window passes, and with no stamp at once (48.713ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13132.736625
```

Metric: one fewer CLI launch, fifteen to fourteen (6.7%). Baseline focused duration 2220.997625ms; after 2192.971375ms. Single samples do not establish a stable speedup. The real-store fixture preserves title, tag, goal link and creation point, closes before readiness, and leaves every live action and refusal assertion intact.

Proof artifact: atris/runs/2026-10-14-task-aic-12-2026-10-14T20-24-49-398Z.json. Task AIC-12 is in Review, never self-accepted. The task runner initially used an older Node without node:sqlite and exited 1; explicit /opt/homebrew/bin/node passed. The automatic rerun allowlist does not allow the absolute path, so task approval still needs review.

Commands and artifacts: git status --short; atris; mission status; brain activate --root . --verify; task list/new/claim/note/ready; mission goal --json (no candidate); mission attach-task (busy launcher lock, no changes); baseline focused test; combined test command above; git diff --check; brain compile --root . (plan only); git diff; git add/commit/push. Generated TODO changes from this task restored to the initial clean version; task truth stays in the database. Downstream map references shifted four lines.

Lesson: creation-only fixture setup can use the real store while refusal checks continue to exercise the actual CLI; use the current Node explicitly inside saved checks when the runner PATH picks an older runtime.

next_push: Seed the waiting-for-human task creation in the same dry-run safety test, preserving its unchanged version and event checks after continuation.
layer: capabilities

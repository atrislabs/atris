Human approval selection setup now launches eight commands instead of nine; the focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-certified-review-fallback-setup.md.

Rerunnable verification command, exit 0:
`node --test --test-name-pattern='task next surfaces Endgame fallback for human-only certified review' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Actual output excerpt:
```text
✔ task next surfaces Endgame fallback for human-only certified review (1118.707833ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 1256.05325
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10886.221458
```

Metric: one creation-only CLI launch removed, nine to eight (11.1%). Baseline focused duration 1423.439167ms; after 1256.05325ms. Single samples do not establish a stable timing gain. All claim, ready, review, JSON/text selection, explicit follow-up creation, repeated human approval selection and final show assertions are unchanged. The real task store preserves title, tag and creation point, and closes before CLI use.

Proof artifact: atris/runs/2026-10-14-task-aic-14-2026-10-14T20-29-03-141Z.json. Task AIC-14 is in Review, never self-accepted. Saved proof reran the same checks using /opt/homebrew/bin/node and passed, exit 0. That absolute path is outside the automatic certification allowlist, so acceptance still requires review. Mission fields and verifier were not changed.

Commands and artifacts: git status --short; atris; brain activate --root . --verify; mission status; mission goal --json (no candidate); task list/new/claim/note/ready; baseline focused test; combined verification above; git diff --check; git diff; brain compile --root . (plan only); git add/commit/push. Generated TODO changes restored to the initially clean version; durable task truth stays in the database. Activation-only local brain/wiki files were absent. No new dependencies or production changes.

Lesson: inspect the current source before following a handoff because nearby review-loop fixtures may already be optimized. Replace only setup creation through the real store and retain real CLI approval coverage. Count saved launches separately from timing samples.

next_push: Replace the creation-only launch in the natural-language task action test while retaining every claim, readiness, review and refusal assertion on the CLI.
layer: capabilities

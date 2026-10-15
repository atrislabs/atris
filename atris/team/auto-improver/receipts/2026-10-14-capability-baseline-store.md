# Capability safety baseline setup reduction

The capability safety test now launches three commands instead of four. Its focused check and all 35 required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-capability-baseline-store.md.

Plan: creation + baseline through production store -> CLI capability checks -> CLI final state comparison.

The existing store connection now reads the initial projection. The compared fields (current_version, latest_event_type and status) are store fields, so enrichment is unnecessary. Both capability commands and final show remain real CLI invocations. Every behavior assertion remains. Launches: 4 -> 3, a 25% reduction; no elapsed-time speedup claimed.

Real output:
```text
node --test --test-name-pattern='^task capabilities-check reports contract drift without mutating task truth$' test/commands.test.js
✔ task capabilities-check reports contract drift without mutating task truth (393.76825ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 528.165542
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 9861.97625
exit 0

git diff --check
(no output)
exit 0
```

Task AIC-81 is in Review. Ready ran git diff --check, exit 0, and saved atris/runs/2026-10-15-task-aic-81-2026-10-15T00-48-58-386Z.json. No self-acceptance. Brain activation and compile returned plan-only, leaving policy files untouched. Existing notebook changes were preserved and excluded from staging.

The prior handoff was stale: the drain API test already seeds all five reviewed parents through the production store. Keep its final CLI read, which proves in-process and CLI views agree.

Lesson: use the existing fixture connection for baseline fields directly supplied by the production store, then compare against the real CLI after the operation.

next_push: Read the safe review action dry-run baseline through the production store while retaining live dry-run and final CLI safety checks.
layer: capabilities

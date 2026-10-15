# Weak proof review creation setup reduction

The weak proof review test now launches six commands instead of seven. The focused CLI test and all 35 frozen checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-lanes-creation-store.md.

Plan: production store creation and ownership -> CLI readiness and review -> CLI queue selection and acceptance safety checks.

Creation now shares the existing production-store ownership setup. Title, tag, workspace and goal are preserved, the display reference comes from the store, and finally closes the connection. Every behavior assertion remains. CLI launches: 7 -> 6, a 14% reduction; no elapsed-time speedup claimed.

Real output:
```text
node --test --test-name-pattern='^task review lanes block weak golden-path mission XP proof from accept$' test/commands.test.js
✔ task review lanes block weak golden-path mission XP proof from accept (869.763875ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 1009.511375
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 11130.293708
exit 0

git diff --check
(no output)
exit 0
```

Task AIC-80 is in Review. First ready attempt with bare node selected an older runtime and failed with ERR_UNKNOWN_BUILTIN_MODULE for node:sqlite, exit 1. Repeating the focused proof with /opt/homebrew/bin/node passed, exit 0, saved at atris/runs/2026-10-15-task-aic-80-2026-10-15T00-47-24-778Z.json. The absolute runtime requires separate review for certification; no self-acceptance. Brain activation and compile returned plan-only, without writing policy files. Pre-existing notebook changes were preserved and excluded from staging.

Lesson: combine creation with existing ownership seeding to remove startup work while keeping weak-proof rejection exercised through the real CLI.

next_push: Reduce setup launches in the review-lane drain API test by seeding its parent through the production task store while retaining live drain requests and assertions.
layer: capabilities

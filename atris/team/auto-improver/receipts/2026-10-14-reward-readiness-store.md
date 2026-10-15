# Reward readiness setup

Reward testing now uses three app launches instead of four. The focused test and all 35 required health checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt. Task commands refreshed atris/TODO.md; its existing unrelated changes are excluded, as are existing lib/task-db.js and test/landing-proof.test.js edits.

Plan: production store creation -> claim -> ready -> close -> CLI acceptance -> collection -> local status. The original proof, actor and all assertions remain. Collection and status both write shared state through commands/xp.js:1050, so they cannot safely run together. Readiness uses production readyTask and the existing fixture result; no CLI readiness output was asserted here.

Proof commands and actual output:

```text
node --test --test-name-pattern='^task accept automatically projects accepted proof into durable local XP ledger$' test/commands.test.js
Before: pass 1, fail 0, test 605.794583ms, duration_ms 742.133875; exit 0.
After: pass 1, fail 0, test 484.856291ms, duration_ms 623.873792; exit 0.

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 13630.031042
exit 0

git diff --check
(no output), exit 0.
```

Metric: one setup-only app launch removed, four become three. Single-run timings are evidence of local execution, not a stable speed estimate.

Notebook compile was attempted and returned plan-only, exit 2; generated policy files were not written.

next_push: seed setup-only readiness in the non-positive reward rejection test while retaining acceptance refusal and unchanged review-state CLI checks.
layer: capabilities

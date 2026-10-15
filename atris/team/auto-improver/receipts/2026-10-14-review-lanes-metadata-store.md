# Review-lanes metadata setup reduction

The review test uses seven child processes instead of eight. The focused real CLI check passed 1/1 and the frozen three-file check passed 35/35, both exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-lanes-metadata-store.md.

Plan: CLI creation and review -> in-process metadata injection -> CLI queue and acceptance gates -> review and push.

Change: replace the separate Node SQLite setup process with the production task store connection, preserving every metadata field, timestamp update and behavior assertion; close in finally. Total child launches decrease 8 to 7 (12.5%); CLI launches remain 7. No matched timing baseline was collected, so no elapsed-time gain is claimed.

Real command output:
```text
node --test --test-name-pattern='^task review lanes block weak golden-path mission XP proof from accept$' test/commands.test.js
✔ task review lanes block weak golden-path mission XP proof from accept (1037.96825ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 1206.377833
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 11020.971667
exit 0
```

Lesson: post-review metadata injection needs no child process; opening and closing the real task store retains the same persisted fixture read by the actual CLI checks.

Upkeep: brain activation requested a plan only, exit 2. Compile also remains plan-only. Pre-existing notebook changes are preserved outside the commit. Task AIC-73 goes to Review without self-acceptance; mission fields and frozen verifier are unchanged.

next_push: Replace the metadata-seeding subprocess in the review queue hygiene test with an in-process update, keeping queue and continuation checks on the CLI.
layer: capabilities

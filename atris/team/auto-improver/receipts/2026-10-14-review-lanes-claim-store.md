# Review lanes setup ownership reduction

The weak-proof review test uses seven CLI launches instead of eight. Its focused check passed 1/1 and the required three-file check passed 35/35, both exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-lanes-claim-store.md.

Plan: CLI creation -> production store ownership -> CLI readiness, review and acceptance checks -> review and push.

Change: seed ownership through production taskStore.claimTask, assert success and close in finally. All existing behavior assertions remain unchanged. This removes one of eight CLI launches (12.5%) and reduces total child launches from nine to eight, including the existing metadata seed subprocess. No matched timing baseline was collected, so no elapsed-time improvement is claimed.

Real command output:
```text
node --test --test-name-pattern='^task review lanes block weak golden-path mission XP proof from accept$' test/commands.test.js
✔ task review lanes block weak golden-path mission XP proof from accept (1026.275875ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 1165.626208
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 11957.338
exit 0

git diff --check
(no output)
exit 0
```

Lesson: setup ownership can use the real task store while readiness, review, queue classification, current selection, refused human acceptance and automatic-accept dry run continue to exercise the actual CLI.

Upkeep: brain activation and compile were plan-only. Pre-existing notebook edits are preserved outside this commit. Task AIC-72 is submitted for review, never self-accepted. The mission and frozen verifier remain unchanged.

next_push: Replace the metadata-seeding Node subprocess in the same review-lanes test with an in-process SQLite update, retaining all CLI acceptance checks.
layer: capabilities

Clean preview reads now run together; the focused real CLI test passed with exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, this receipt, and atris/team/auto-improver/logs/2026-10-15.md.

Plan: prepare fixture -> read both formats together -> retain all checks.

Rerun: /opt/homebrew/bin/node --test --test-name-pattern='^clean dry-run shows MAP refs it would heal$' test/commands.test.js
Output: pass 1, fail 0. Exit 0.
Before: 180.135792ms. After: 95.684917ms. These are single observations, not a stable benchmark. Sequential launch stages fall from two to one; both real CLI launches and every assertion remain.

Required check: node --test test/roster-run-record.test.js
Output: tests 12, pass 12, fail 0, duration_ms 10884.289542. Exit 0.
Frozen command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Output: tests 12, pass 12, fail 0, duration_ms 10544.192333; clean, no slop tells in 5 files. Exit 0.

The work record is ready for review. The mission attachment was blocked by an existing lock, so a separate work record holds proof. Brain refresh reported a preview only; no generated files were changed. Existing unrelated edits were left alone.

Learned: both clean preview formats finish their reads before the unchanged-file check, so they can share one launch stage.
next_push: batch the independent clean JSON and text checks in the adjacent preview test after confirming its fixture stays unchanged.
layer: capabilities

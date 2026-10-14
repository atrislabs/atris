Filtered task reference setup now starts two fewer commands; the affected check and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task-generated), atris/team/auto-improver/logs/2026-10-14.md, and this receipt.

Changed-surface proof: `node --test --test-name-pattern="task display refs stay stable in filtered list views" test/commands.test.js`
Before: ✔ task display refs stay stable in filtered list views (738.763875ms), pass 1, fail 0, exit 0.
After: ✔ task display refs stay stable in filtered list views (519.876667ms), pass 1, fail 0, exit 0.

Required proof: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output: tests 35, pass 35, fail 0, duration_ms 9917.744583. Exit 0.

Review submission: the default shell selected an older Node without node:sqlite and exited 1. Re-running with `/opt/homebrew/Cellar/node/25.6.1/bin/node --test --test-name-pattern='task display refs stay stable in filtered list views' test/commands.test.js` exited 0 and moved the work to review. No test code changed after the successful required checks.

Progress: two creation launches removed; the completion and three filtered list calls remain real CLI invocations. Every prior assertion is retained. The observed affected-test time fell by 218.887208 ms (29.6%); this single before/after sample is not a timing guarantee.

Lesson: Calculate both display references after ordered fixture inserts so the filtered lists must retain the full-store numbering. Close the seed database before CLI calls.
next_push: Remove creation launches from the pending-human-proof list test while retaining claim, ready, list, and revise CLI checks.
layer: capabilities

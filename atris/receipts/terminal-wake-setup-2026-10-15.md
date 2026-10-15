Removed one terminal wake setup launch; the focused test and all twelve required checks passed, exit 0, with zero slop.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/receipts/terminal-wake-setup-2026-10-15.md. Member log appended at atris/team/auto-improver/logs/2026-10-15.md.
Focused command: node --test --test-name-pattern='member wake asks instead of ticking a goal pinned to a terminal mission' test/commands.test.js
Output: tests 1, pass 1, fail 0; exit 0.
Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
Output: tests 12, pass 12, fail 0; clean, no slop tells in 3 files; exit 0.
Metric: five launches become four. Single-run case time was 738.538208 ms before and 716.311208 ms after; launch removal is the durable improvement.
Learned: the production scaffold prepares the member while terminal wake decisions remain real command checks.
next_push: replace the bookkeeping wake test's member setup launch with the production scaffold.
layer: capabilities

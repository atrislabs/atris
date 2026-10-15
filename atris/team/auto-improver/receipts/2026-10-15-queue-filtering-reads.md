Queue filtering reads now run together; the focused real CLI test passed with every assertion retained, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-queue-filtering-reads.md.
Verify: `/opt/homebrew/bin/node --test --test-name-pattern='^task queue filters certified review rows by continue-work and human-accept waiting state$' test/commands.test.js`.
Before output: case 429.735542 ms, pass 1, fail 0, exit 0.
After output: case 219.644125 ms, pass 1, fail 0, exit 0.
Progress: three sequential CLI launch stages become one, with the same three launches. Observed case time fell 48.9%; no timing threshold added.
Learned: each response derives from unchanged stored rows; writing the derived view does not feed another read. Setup closes before all three children, and cleanup waits for every child.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Existing unrelated edits are excluded. Brain activation returned plan-only, exit 2; optional boot files were absent.
next_push: inspect the adjacent stale-proof routing test for setup-only launches to replace with production-store calls.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. `git diff --check` exited 0. Brain compile returned plan-only, exit 2.
layer: capabilities

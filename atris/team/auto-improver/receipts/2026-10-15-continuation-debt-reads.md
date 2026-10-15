Continuation debt checks now run together; the focused real CLI test passed, exit 0, with every assertion retained.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-continuation-debt-reads.md.
Verify: `/opt/homebrew/bin/node --test --test-name-pattern='^task review hygiene reports generic continuation debt without mutation$' test/commands.test.js`.
Before output: case 489.975917 ms, pass 1, fail 0, exit 0.
After output: case 345.614959 ms, pass 1, fail 0, exit 0.
Progress: three sequential CLI stages become two, with the same three launches. Observed case time fell 29.5%; no timing threshold added.
Learned: the refused continuation exits before stored-row or derived-view writes. Queue inspection saves its own derived view, which the refusal does not consume. Both commands finish before cleanup.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Unrelated existing edits are excluded. Brain activation returned plan-only, exit 2; optional boot files were absent.
next_push: inspect the adjacent continuation display test for setup-only launches that can use the production store.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0; `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. The focused check rerun while saving review proof exited 0. Brain compile returned plan-only, exit 2.
layer: capabilities

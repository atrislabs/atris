Continuation debt setup uses one fewer launch; the focused real CLI test passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-continuation-debt-setup.md.
Check: `/opt/homebrew/bin/node --test --test-name-pattern='^task review hygiene reports generic continuation debt without mutation$' test/commands.test.js`.
Before output: case 646.817042 ms, pass 1, fail 0, exit 0.
After output: case 479.672333 ms, pass 1, fail 0, exit 0.
Progress: four CLI launches become three, a 25% reduction; observed case time fell 25.8%, with no timing threshold added.
Learned: readiness is fixture setup here; production readyTask preserves the review state while CLI review, queue inspection and continuation refusal retain their assertions. The connection closes before the CLI runs.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Unrelated existing edits are excluded. Brain activation returned plan-only, exit 2; several optional boot files were absent.
next_push: batch queue inspection and refused continuation in the debt check after confirming the refusal path leaves stored rows unchanged.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0; `pass 12`, `fail 0`, `clean, no slop tells in 5 files`. Focused check rerun while saving review proof exited 0. Proof is ready for review. Brain compile returned plan-only, exit 2.
layer: capabilities

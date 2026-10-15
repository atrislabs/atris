Generic continuation setup uses one fewer program launch; the focused real CLI test passed with every behavior assertion retained.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-generic-continuation.md.
Rerun: `node --test --test-name-pattern='^task continue-work rejects generic human-accept continuation titles$' test/commands.test.js`
Before output: case 822.843125 ms, pass 1, fail 0, exit 0.
After output: case 744.638209 ms, pass 1, fail 0, exit 0.
Progress: six program launches become five; the observed case was 9.5% faster. No timing threshold was added.
Learned: preserve the goal link in task metadata and close the store before running the real commands. The existing neighboring fixture provides the same production-store pattern.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Other pre-existing edits are excluded. Brain activation returned plan-only with exit 2; generated files were left alone.
next_push: batch current-selection and review-queue reads in the generic continuation rejection check.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0; `pass 12`, `fail 0`, `✓ clean, no slop tells in 5 files`. Review proof saved. Brain compile returned plan-only, exit 2.
layer: capabilities

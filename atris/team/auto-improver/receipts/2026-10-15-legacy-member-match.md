## Legacy member match setup
The legacy matching test now prepares its task through the production store; the focused real CLI check passed with exit 0 and every matching assertion retained.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-legacy-member-match.md.
Rerun: `node --test --test-name-pattern='^auto-improver dry-run matches legacy recurring-pattern task title$' test/commands.test.js`
Before: pass 1, fail 0, case 335.493167 ms, exit 0.
After: pass 1, fail 0, case 222.884791 ms, exit 0.
Progress: three CLI launches become two; the observed case was 33.6% faster, with no timing threshold added.
Learned: this read uses the saved task list. A store-only row did not reproduce the fixture; the production task list must be saved too, with its parent folder created. The store closes in finally before the real read.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Unrelated pre-existing edits are excluded.
next_push: replace one nearby setup-only task launch with the production store and saved task list where needed.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0; `pass 12`, `fail 0`, `✓ clean, no slop tells in 5 files`.
layer: capabilities

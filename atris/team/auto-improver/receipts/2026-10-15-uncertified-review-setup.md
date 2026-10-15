# Uncertified review setup

Uncertified review setup uses three launches instead of four; the focused real CLI test passed with every assertion retained, exit 0.
Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-uncertified-review-setup.md.
Plan: store creation -> store claim -> store readiness -> CLI selection and both status reads.
Verify: `node --test --test-name-pattern='^task next names accept for uncertified review and leaves open work unclaimed$' test/commands.test.js`.
Before output: pass 1, fail 0, case 584.441584 ms, exit 0.
After output: pass 1, fail 0, case 568.117417 ms, exit 0.
Progress: four launches become three, a 25% reduction. Timing is observational; no threshold added.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Learned: readiness can reuse the production creation connection with the same actor and proof, closed in finally before real CLI behavior checks.
Existing unrelated edits remain excluded. Brain activation returned plan-only.
next_push: replace readiness setup in the adjacent duplicate Endgame seed fixture with a production-store call.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: pass 12, fail 0, duration 12216.400917 ms; clean, no slop tells in 5 files. `git diff --check` exited 0.
The saved task check first selected an older Node without the built-in SQLite module and failed before loading the test. Repeating with `/opt/homebrew/bin/node` passed, exit 0; work is ready for review. Brain compile returned plan-only.
next_push: replace readiness setup in the adjacent duplicate Endgame seed fixture with a production-store call.
layer: capabilities

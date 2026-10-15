# Certified review setup

Certified review setup starts the program one fewer time; the focused real CLI test passed, exit 0, retaining every assertion.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-certified-review-setup.md.
Plan: store creation -> store claim -> store readiness -> real CLI certification and selection.
Verify: `node --test --test-name-pattern='^task next surfaces Endgame fallback for human-only certified review$' test/commands.test.js`.
Before output: case 950.7765 ms, pass 1, fail 0, exit 0.
After output: case 824.216417 ms, pass 1, fail 0, exit 0.
Progress: seven launches become six, a 14.3% reduction. Observed case time fell 13.3%; no timing threshold added.
Required file: `node --test test/roster-run-record.test.js`, output `pass 12`, `fail 0`, duration 10445.410959 ms, exit 0.
Required combined check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Learned: readiness can reuse the production creation connection with the same actor and proof. It closes in finally before the real CLI review and selection checks.
Existing unrelated edits remain excluded. Brain activation returned plan-only; optional boot files were absent.
next_push: replace readiness setup in the adjacent scoped certified-review fixture with a production-store call.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, duration 10031.360125 ms; `clean, no slop tells in 5 files`. Focused proof was rerun through the task check and exited 0; the work is ready for review. Brain compile returned plan-only.
layer: capabilities

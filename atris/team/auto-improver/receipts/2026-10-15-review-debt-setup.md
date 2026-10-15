# Review debt setup

Review debt setup starts the program one fewer time; the focused real CLI test passed, exit 0, with every selection assertion retained.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-review-debt-setup.md.
Plan: store creation -> store claim -> store readiness -> real CLI selection.
Verify: `node --test --test-name-pattern='^task next surfaces review debt when no open work exists$' test/commands.test.js`.
Before output: case 296.21975 ms, pass 1, fail 0, exit 0.
After output: case 170.355333 ms, pass 1, fail 0, exit 0.
Progress: two launches become one, a 50% reduction. Observed case time fell 42.5%; no timing threshold added.
Learned: readiness setup can reuse the production creation connection with the same actor and proof. The store closes in finally before CLI selection.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Existing unrelated edits remain excluded. Brain activation returned plan-only; optional boot files were absent.
next_push: replace the adjacent certified-review fixture readiness launch with a production-store call.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, total 9859.420583 ms; `clean, no slop tells in 5 files`. `git diff --check` exited 0. Saving proof with bare node picked an older runtime without node:sqlite and exited 1; repeating with `/opt/homebrew/bin/node --test --test-name-pattern='^task next surfaces review debt when no open work exists$' test/commands.test.js` exited 0 and moved the work to review. Brain compile returned plan-only.
layer: capabilities

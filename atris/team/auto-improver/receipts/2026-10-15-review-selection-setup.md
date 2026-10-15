# Review selection setup

Review selection setup starts the program one fewer time; the focused real CLI test passed, exit 0, with every assertion retained.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-review-selection-setup.md.
Plan: create -> store claim -> real CLI readiness -> selection -> both row inspections.
Verify: `node --test --test-name-pattern='^task next names accept for uncertified review and leaves open work unclaimed$' test/commands.test.js`.
Before output: case 707.572208 ms, pass 1, fail 0, exit 0.
After output: case 557.467458 ms, pass 1, fail 0, exit 0.
Progress: five launches become four, a 20% reduction. Observed case time fell 21.2%; no timing threshold added.
Learned: ownership setup can reuse the production creation connection while preserving the real readiness and selection checks. The store closes in finally before any CLI call.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
The supplied prior output showed passing cases, not an assertion failure. Existing unrelated edits remain excluded. Brain activation returned plan-only, and optional boot files were absent.
next_push: replace the adjacent review-debt fixture readiness launch with a production-store call.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js` exited 0, output `pass 12`, `fail 0`, total 9974.088875 ms. `node bin/atris.js slop --staged` exited 0, output `clean, no slop tells in 5 files`. `git diff --check` exited 0. Saved focused proof passed again and moved the work to review. Brain compile returned plan-only.
layer: capabilities

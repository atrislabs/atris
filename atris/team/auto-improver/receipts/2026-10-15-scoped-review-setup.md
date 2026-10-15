# Scoped review setup

Scoped review setup starts the program one fewer time; the focused real CLI test passed, exit 0, retaining every assertion.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-15.md, atris/team/auto-improver/receipts/2026-10-15-scoped-review-setup.md.
Plan: store creation -> store claim -> store readiness -> real CLI certification and scoped selection.
Verify: `node --test --test-name-pattern='^task next scoped by tag does not surface unrelated Endgame fallback$' test/commands.test.js`.
Before output: case 697.811209 ms, pass 1, fail 0, exit 0.
After output: case 581.403834 ms, pass 1, fail 0, exit 0.
Progress: five launches become four, a 20% reduction. Observed case time fell 16.7%; no timing threshold added.
Required check: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.
Learned: readiness can reuse the production creation connection with the original actor and proof, closing in finally before real CLI review and scoped selection.
Existing unrelated edits remain excluded. Brain activation and compile returned plan-only; optional boot files were absent.
next_push: replace setup readiness in the uncertified review selection fixture with a production-store call.
layer: capabilities

Final proof: `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged` exited 0. Output: `pass 12`, `fail 0`, duration 12776.882916 ms; `clean, no slop tells in 5 files`. `git diff --check` exited 0. Focused proof reran through the task check and exited 0; work is ready for review.
layer: capabilities

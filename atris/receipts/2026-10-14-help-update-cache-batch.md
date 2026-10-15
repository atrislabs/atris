# Help update-cache checks run together

The six help launches that check for update-cache writes now run together. Each still gets its own home folder, and every exit and no-cache assertion remains, checked per command after all six finish.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Metric: six sequential waiting stages become one. Three focused samples before were 522ms, 519ms, and 529ms; three after were 97ms, 97ms, and 98ms.

Finding: both CLI runners set the skip-update variable, so this test passes even if help stopped skipping the update check. The batch keeps the test exactly as strong as before; it does not fix that gap.

Proof:
- `node --test --test-name-pattern='^help invocations skip background update-check' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

Rerun: `node --test --test-name-pattern='^help invocations skip background update-check' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: clear the skip-update variable in this test so it proves help alone skips the update check, then confirm it fails when the help gate is removed.
layer: capabilities

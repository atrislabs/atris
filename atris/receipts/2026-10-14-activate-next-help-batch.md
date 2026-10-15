# Activate and next help checks run together

The activate and next help launches now run together in one test. Every output and no-state assertion remains, checked per command after both finish.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Metric: two sequential waiting stages become one. Three focused samples before were 181ms, 180ms, and 181ms; three after were 94ms, 96ms, and 93ms. Help returns before any workflow context loads, so the launches share no state.

Proof:
- `node --test --test-name-pattern='^activate and next --help' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

Rerun: `node --test --test-name-pattern='^activate and next --help' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: find the next test that runs several independent help launches in a loop and run them together.
layer: capabilities

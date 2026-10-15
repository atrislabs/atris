# Account and integrations help checks run together

The four account and integrations help launches now run together in one test. Every output and no-state assertion remains, checked per command after all four finish.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Metric: four sequential waiting stages become one. Three focused samples before were 351ms, 349ms, and 355ms; three after were 91ms, 94ms, and 92ms. The CLI returns help before loading any account handler, so the launches share no state.

Proof:
- `node --test --test-name-pattern='^account and integrations --help' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

Rerun: `node --test --test-name-pattern='^account and integrations --help' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: batch the activate and next help checks, which are also independent read-only launches.
layer: capabilities

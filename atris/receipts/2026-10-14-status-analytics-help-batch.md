# Status and analytics help checks run together

The status and analytics help launches now run together in one test. Every output and no-state assertion remains, checked per command after both finish.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Metric: two sequential waiting stages become one. Three focused samples before were 180ms, 178ms, and 177ms; three after were 92ms, 93ms, and 91ms. Both commands return help before looking for a workspace, so the launches share no state.

Proof:
- `node --test --test-name-pattern='^status and analytics --help' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

Rerun: `node --test --test-name-pattern='^status and analytics --help' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: batch the update and sync help checks, rewriting the skill file once before both launches start.
layer: capabilities

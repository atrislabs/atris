# Update and sync help checks run together

The update and sync help launches now run together. Each gets its own home folder and its own skill file, written before both start, so neither launch can mask a change made by the other. Every output, skill-file, and no-state assertion remains.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Metric: two sequential waiting stages become one. Three focused samples before were 177ms, 177ms, and 175ms; three after were 92ms, 93ms, and 90ms.

Fault check: a planted line in `bin/atris.js` that made sync help overwrite its skill file failed the test with a strict-equal assertion. The CLI file was restored, and `git diff --stat bin/atris.js` shows no change. The failure message shows the file contents but does not name the command.

Proof:
- `node --test --test-name-pattern='^update and sync --help' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

Rerun: `node --test --test-name-pattern='^update and sync --help' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: scan test/commands.test.js for single-launch help tests that sit next to each other and could share one batched test, starting with upgrade and now help.
layer: capabilities

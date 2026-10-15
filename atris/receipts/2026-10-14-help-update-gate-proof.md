# Help update-cache test now proves the help gate

The help update-cache test now clears both skip-update variables for its six launches. Before, the test helper turned the update check off by itself, so the test passed even if help stopped skipping it.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Fault check: with the help condition removed from the skip rule in `bin/atris.js`, the test failed five of five runs ("experiments --help created ~/.atris"). The CLI file was restored after each plant, and `git diff --stat bin/atris.js` shows no change.

Limit: the fault only shows when the package registry answers, because the cache is written after a successful fetch. Offline, a broken gate passes silently. A correct gate never reaches the network, so the passing case adds no network wait.

Metric: passing runs stay at 95ms, 96ms, and 97ms, the same as last tick.

Proof:
- `node --test --test-name-pattern='^help invocations skip background update-check' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

Rerun: `node --test --test-name-pattern='^help invocations skip background update-check' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: batch the status and analytics help checks, two more independent read-only launches.
layer: capabilities

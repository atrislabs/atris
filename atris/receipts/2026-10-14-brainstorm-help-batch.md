# Brainstorm help checks run together

Three real CLI help checks now run together. The focused check passed with all original output and no-state assertions retained.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/receipts/2026-10-14-brainstorm-help-batch.md`, `atris/team/auto-improver/logs/2026-10-14.md`.

The help handler returns before workspace discovery or journal writes, so these calls share no writable state. The existing async CLI helper waits for every child to close before assertions and folder cleanup.

Metric: three sequential CLI waiting stages become one; three real CLI launches remain. Single samples: case 268.952625ms before and 93.34125ms after; whole file 416.694709ms before and 233.860042ms after. These samples do not establish a stable wall-time gain.

Commands and output:

- `node --test --test-name-pattern='^brainstorm help' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`, `duration_ms 233.860042`.

- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: exit 0, `tests 12`, `pass 12`, `fail 0`, `duration_ms 10256.404042`; `clean, no slop tells in 5 files`.
- `git diff --check`: exit 0, no output.
- `atris brain activate --root . --verify` and `atris brain compile --root .`: exit 2, plan only; no generated policy files changed.

Rerun: `node --test --test-name-pattern='^brainstorm help' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: batch the two independent login and identity help checks, retaining the checks for no authentication state.
layer: capabilities

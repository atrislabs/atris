# Authentication help checks run together

Login and identity help now run together. Sign-out help still follows the saved-credential setup, and all original assertions remain.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Metric: three CLI launches remain, but three sequential waiting stages become two. Single focused samples were 263.962292ms before and 262.884875ms after, so no measurable wall-time improvement is claimed. The CLI returns help before invoking authentication handlers, and the async helper waits for both children to close before the credential fixture is written.

Proof:
- `node --test --test-name-pattern='^auth --help' test/commands.test.js`: exit 0, `tests 1`, `pass 1`, `fail 0`, `duration_ms 417.0665`.

- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: exit 0, `tests 12`, `pass 12`, `fail 0`, `duration_ms 10260.917542`; `clean, no slop tells in 5 files`.
- `atris task ready AIC-3 --verify "/opt/homebrew/bin/node --test --test-name-pattern='^auth --help' test/commands.test.js"`: exit 0, ready for approval; execution receipt `atris/runs/2026-10-15-task-aic-3-2026-10-15T06-14-00-081Z.json`. Human approval remains pending.
- `atris brain compile --root .`: plan only; no generated policy changes.
- `git diff --check`: exit 0, no output.

Rerun: `node --test --test-name-pattern='^auth --help' test/commands.test.js && node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`.

next_push: batch the four independent account and integrations help checks while retaining every session-state assertion.
layer: capabilities

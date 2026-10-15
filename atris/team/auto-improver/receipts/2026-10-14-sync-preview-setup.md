# Sync preview setup

Sync preview testing now uses three command launches instead of four; focused and required health tests passed, exit 0.

- files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.
- change: creation and ownership share the production task store connection, closed in finally before CLI message, readiness and sync checks. All sync assertions remain.
- metric: four CLI launches become three. Focused samples: 538.146ms before, 464.146167ms after; these single samples do not establish a stable timing gain.
- focused command: `node --test --test-name-pattern='^task sync dry-run maps local tasks to canonical cloud task writes$' test/commands.test.js`
- focused output: `✔ task sync dry-run maps local tasks to canonical cloud task writes (464.146167ms)`; tests 1, pass 1, fail 0, duration_ms 612.462792, exit 0.
- frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
- frozen output: tests 35, pass 35, fail 0, duration_ms 15023.335959, exit 0.
- checks: git diff --check, exit 0. Brain activation and compile returned plan-only exit 2; generated files were not written.
- state commands: mission status, mission goal --json (no candidate), task list --status open, task new/claim/note/ready; git status, diff, log, commit and push.
- review: task ready reran the focused command successfully and moved proof to review. The absolute runtime path is outside automatic certification, so second review remains pending. An initial result sentence was refused for lacking a plain benefit; the corrected sentence was accepted.
- learned: sync preview assertions already verify the owner and lease metadata, so setup ownership can use the production store without removing command behavior coverage from the sync surface.
- next_push: seed setup ownership in the default review screen test through the production store, retaining readiness, review and screen CLI checks.
- unrelated edits: lib/task-db.js, test/landing-proof.test.js, rendered TODO and earlier log additions remain unstaged.

layer: capabilities

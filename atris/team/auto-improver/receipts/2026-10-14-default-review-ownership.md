# Default review ownership setup

Review screen testing now uses three command launches instead of four; focused and required health tests passed, exit 0.

- files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.
- change: setup ownership uses production claimTask beside creation; its success is asserted and the connection closes in finally before CLI readiness, certification and the review screen. All existing screen assertions remain.
- metric: four CLI launches become three. Focused samples: 589.749541ms before, 451.66675ms after; single samples do not establish a stable timing gain.
- focused command: `node --test --test-name-pattern='^review default mode leads with certified accept like first-minute$' test/commands.test.js`
- focused output: `✔ review default mode leads with certified accept like first-minute (451.66675ms)`; tests 1, pass 1, fail 0, duration_ms 591.145583, exit 0.
- frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
- frozen output: tests 35, pass 35, fail 0, duration_ms 13646.937666, exit 0.
- artifacts: this receipt, map pointers, member log and task proof ready for review.
- state commands: brain activate and compile (plan-only, exit 2), mission status, mission goal --json (no candidate), task list/current/new/claim/note/ready, git status/diff/log/remote/commit/push. Missing compiled brain files were observed, with no generated policy changes.
- review: the first task-ready attempt resolved an older Node without node:sqlite and failed; using /opt/homebrew/bin/node passed. A landing sentence was initially rejected for missing a plain benefit; the corrected sentence moved proof to review. Automatic certification cannot rerun absolute runtime paths, so second review remains pending. git diff --check passed, exit 0.
- learned: ownership is fixture setup for the review screen; successful CLI readiness and certification still exercise the real path to the displayed approval command.
- unrelated edits: task store, landing proof test, rendered TODO and earlier member log additions remain unstaged.
- next_push: inspect the review screen fixture for setup-only readiness that can use the production store while retaining CLI certification and screen coverage.

layer: capabilities

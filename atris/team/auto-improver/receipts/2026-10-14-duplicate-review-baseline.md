# Duplicate review baseline read

The duplicate-review check starts one fewer command; the changed test and all 35 required tests passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md. Artifact: atris/team/auto-improver/receipts/2026-10-14-duplicate-review-baseline.md.
Plan: real-store baseline -> real review runs -> final CLI identity, version and message checks.
Change: read the baseline from the real SQLite task projection with full history, assert the row exists in review with a positive version and message array, and close the store in finally. Keep all existing CLI mutation and final read assertions; add identity parity.
Baseline command: node --test --test-name-pattern='task review-lane-run does not repeat the same review_chat task across inner loops' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 972.813ms, duration_ms 1111.531375. Exit: 0.
Changed command: node --test --test-name-pattern='task review-lane-run does not repeat the same review_chat task across inner loops' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 838.797875ms, duration_ms 972.750125. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 10064.019875. Exit: 0.
Metric: launches reduced from seven to six. The single subtest comparison saved 134.015125ms, about 14%; this is not a stable benchmark.
Review: existing task-store projection provides both version and full messages. Final CLI reads preserve public output coverage. No product code, dependencies, mission fields, or tool policies changed.
Proof submission: the installed proof runner first selected an older Node without SQLite, exit 1. Repeating with /opt/homebrew/Cellar/node/25.6.1/bin/node passed, exit 0; the first landing sentence was refused for missing a plain benefit. The corrected sentence passed and moved work to Review, exit 0. Artifact: atris/runs/2026-10-14-task-aic-24-2026-10-14T17-47-53-071Z.json. Its automatic second-check allowlist cannot rerun this absolute path; no acceptance was attempted.
Brain activation and compilation returned optional plan-only output, exit 2; generated policy edits were not applied.
Lesson: when a baseline counts messages, request full task history to avoid clipped content or limited message lists changing the comparison.
next_push: Seed the existing-follow-up drain test's parent task in process while preserving continuation and drain CLI checks.
layer: capabilities

Quality: git diff --check returned no output, exit 0. atris slop detect --diff reported clean, no slop tells in 5 files, exit 0.
next_push: Seed the existing-follow-up drain test's parent task in process while preserving continuation and drain CLI checks.
layer: capabilities

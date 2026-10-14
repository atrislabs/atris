# Receipt baseline read

The receipt check now starts one fewer command; the changed test and all 35 required tests passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md. Artifact: atris/team/auto-improver/receipts/2026-10-14-bounded-receipt-baseline.md.

Plan: read saved version from real store -> run receipt command -> compare final CLI identity and version.
Change: baseline show is replaced with a real-store projection, closed in finally. Assert baseline exists, is in review, and has a positive version. Preserve final CLI show and every existing assertion, adding identity parity. Enrichment is unnecessary because current_version is supplied by the detailed task-store projection, not command enrichment.

Baseline command: node --test --test-name-pattern='task review-lane-run writes bounded receipts' test/commands.test.js
Output: pass 1, fail 0, subtest 1135.080708ms, duration_ms 1273.870708. Exit: 0.
Changed command: node --test --test-name-pattern='task review-lane-run writes bounded receipts' test/commands.test.js
Output: pass 1, fail 0, subtest 1047.412875ms, duration_ms 1182.161791. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 9951.612333. Exit: 0.

Metric: command launches reduced from eight to seven. Single subtest comparison improved by 87.667833ms, about 8%; this is not a stable benchmark.
Review: real SQLite projection supplies baseline version; the actual CLI still exercises ready, certification, dry and live receipt runs, and final persisted task read. No product code, dependencies, environment, or mission fields changed. Brain activation returned optional plan-only output, exit 2, without applying generated policy edits.
Lesson: read only the projection fields a baseline assertion needs, while preserving the final public read and checking identity to prevent vacuous comparison.
next_push: Replace the duplicate-review-loop baseline show with a real-store detailed projection, preserving final CLI version and message checks.
layer: capabilities

Proof submission: saved targeted command passed, exit 0, and work moved to Review. Artifact: atris/runs/2026-10-14-task-aic-23-2026-10-14T17-45-31-538Z.json. The installed runner required its own invocation and uses an absolute Node path outside the automatic second-check allowlist. No acceptance was attempted.
Quality: git diff --check had no output, exit 0. atris slop detect --diff reported clean, no slop tells in 5 files, exit 0. Brain compilation also returned optional plan-only output, exit 2.
next_push: Replace the duplicate-review-loop baseline show with a real-store detailed projection, preserving final CLI version and message checks.
layer: capabilities

# Duplicate review loop setup

The duplicate-chat check starts one fewer setup command. The changed check and all 35 required tests passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md. Artifact: atris/team/auto-improver/receipts/2026-10-14-duplicate-review-loop-setup.md.

Plan: create unclaimed row in real store -> ready through CLI -> exercise duplicate prevention through both loops and drain.
Change: only fixture creation moved to the real task store, preserving workspace root, goal metadata, and display reference. The store closes in finally. All seven remaining behavior command launches and assertions remain unchanged. There was no claim launch to remove.

Baseline command: node --test --test-name-pattern='task review-lane-run does not repeat' test/commands.test.js
Output: ✔ task review-lane-run does not repeat the same review_chat task across inner loops (1077.213583ms); tests 1, pass 1, fail 0, duration_ms 1215.275834. Exit: 0.
Changed command: node --test --test-name-pattern='task review-lane-run does not repeat' test/commands.test.js
Output: ✔ task review-lane-run does not repeat the same review_chat task across inner loops (981.615708ms); tests 1, pass 1, fail 0, duration_ms 1121.935042. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 9805.240333. Exit: 0.

Metric: one fixture-only CLI launch removed, from eight to seven. One subtest comparison improved by 95.597875ms, about 9%; this is not a stable benchmark.
Review: the diff keeps the fixture unclaimed, retains the exact goal filter, and changes no product code, dependencies, assertions, or environment. Brain activation returned optional plan-only output, exit 2; missing generated files were left alone.
Lesson: preserve an unclaimed fixture when ready owns the transition, rather than adding a claim that would silently change coverage.
next_push: Replace fixture-only creation and claiming in the bounded review-loop receipt check with real-store setup, preserving continuation and human-accept stop assertions.
layer: capabilities

Proof submission: the saved targeted command passed, exit 0, and the task moved to Review. Receipt: atris/runs/2026-10-14-task-aic-21-2026-10-14T17-41-21-302Z.json. The first submission passed verification but required a benefit in the landing sentence; the corrected sentence passed. The installed proof runner needs the supported Node path, which its automatic second-check allowlist cannot rerun; no acceptance was attempted.
Quality: git diff --check had no output, exit 0. atris slop detect --diff reported clean, no slop tells in 5 files, exit 0. Brain compilation returned optional plan-only output, exit 2; no generated policy edits applied.
next_push: Replace fixture-only creation and claiming in the bounded review-loop receipt check with real-store setup, preserving continuation and human-accept stop assertions.
layer: capabilities

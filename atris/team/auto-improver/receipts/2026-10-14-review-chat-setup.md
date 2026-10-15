# Review-chat setup uses fewer command launches

The review-chat check starts two fewer setup commands. The changed check and all 35 required tests passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands also regenerate atris/TODO.md. Artifact: atris/team/auto-improver/receipts/2026-10-14-review-chat-setup.md.

Plan: create real open row -> run early rejection -> claim real row -> keep every proof and review CLI call.
Change: creation and claiming use the real task store with finally cleanup. Preserve task_goal and goal_objective metadata, workspace root, display reference, open-task rejection, and all behavior assertions. No product code or dependencies changed.

Baseline command: node --test --test-name-pattern='task review-chat emits proof-specific verifier packet' test/commands.test.js
Output: ✔ task review-chat emits proof-specific verifier packet (1450.214791ms); tests 1, pass 1, fail 0, duration_ms 1584.88275. Exit: 0.
Changed command: node --test --test-name-pattern='task review-chat emits proof-specific verifier packet' test/commands.test.js
Output: ✔ task review-chat emits proof-specific verifier packet (1164.40225ms); tests 1, pass 1, fail 0, duration_ms 1291.236708. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 10066.832375. Exit: 0.

Metric: two fixture-only CLI launches removed. One subtest timing improved by 285.812541ms, about 20%; this is one comparison, not a stable benchmark.
Review: the first edited run failed the unchanged objective assertion because creation also supplies task_goal. Copying both objective fields fixed the setup mismatch. All original behavior assertions and nine behavior command launches remain.
Quality: git diff --check had no output, exit 0. atris slop detect --diff reported clean, no slop tells in 5 files, exit 0. Brain activation and compilation returned optional plan-only output, exit 2; no generated policy changes applied.
Lesson: direct fixture creation must preserve both task_goal and goal_objective, since the store supplies a default task_goal that otherwise outranks goal_objective.
next_push: Replace fixture-only creation and claiming in the review-lane-run duplicate-chat check with real-store setup, preserving its loop and drain assertions.
layer: capabilities

Proof submission: the saved targeted command passed, exit 0, and the task moved to Review. Receipt: atris/runs/2026-10-14-task-aic-20-2026-10-14T17-38-53-735Z.json. The first submission verified successfully but rejected the landing sentence; a plain benefit sentence passed on retry. The installed proof runner needs the supported Node path, which its automatic second-check allowlist cannot rerun; no acceptance was attempted.
next_push: Replace fixture-only creation and claiming in the review-lane-run duplicate-chat check with real-store setup, preserving its loop and drain assertions.
layer: capabilities

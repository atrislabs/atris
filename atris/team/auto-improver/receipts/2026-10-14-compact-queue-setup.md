The compact approval queue check now uses six fewer setup launches; the affected check and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerated atris/TODO.md. Artifact: atris/team/auto-improver/receipts/2026-10-14-compact-queue-setup.md.
Change: create and claim three review fixtures in the real task database, using the actual workspace root and display-reference map. Close the database in finally. Keep all ready/review calls and JSON/plain/verbose/grouped queue assertions unchanged. No dependencies or product changes.
Before -> after: six setup commands -> three in-process database seeds. The affected subtest fell from 1965.251083ms to 1157.001833ms (808.24925ms, about 41%) in one comparison, not a stable benchmark.
Baseline and affected command: node --test --test-name-pattern='task reviews gives a compact certified accept queue' test/commands.test.js
Baseline output: tests 1, pass 1, fail 0, duration_ms 2111.221834. Exit: 0.
Changed output: task reviews gives a compact certified accept queue (1157.001833ms); tests 1, pass 1, fail 0, duration_ms 1287.506333. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, duration_ms 10399.396958. Exit: 0.
Review: only setup launches changed. Real command writes still supply the certified, blocked, and unsafe queue cases, and every behavior assertion remains.
Lesson: approval-queue integration coverage needs real ready/review writes and queue reads, but creating and claiming its input rows can use the same task store in process.
Setup: brain activation returned plan-only, exit 2, with optional generated files absent; existing workspace preserved.
next_push: Replace repeated fixture creation and claiming in the task review-chat scenario with real-store setup, preserving the review-chat commands and assertions.
layer: capabilities

Proof submission: saved targeted verification passed, exit 0, and task moved to Review. Receipt: atris/runs/2026-10-14-task-aic-19-2026-10-14T17-35-53-782Z.json. The installed proof runner requires the explicit supported Node path; its automatic second-check allowlist cannot rerun absolute executables, so acceptance remains pending review. An earlier submission passed verification but rejected the landing sentence, and a proof-only retry refused an unexecuted command; neither changed the tests.
Quality: atris slop detect --diff -> clean, no slop tells in 5 files, exit 0; git diff --check -> no output, exit 0. Brain compile returned plan-only, exit 2; no generated policy edits applied.
next_push: Replace repeated fixture creation and claiming in the task review-chat scenario with real-store setup, preserving the review-chat commands and assertions.
layer: capabilities

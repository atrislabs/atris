---
name: auto-learned
description: Verified patterns crystallized from passing runs for auto-improver. Bounded to 5 newest patterns so context never bloats.
---

# Auto-Learned Verified Patterns

- **2026-10-14 (capabilities)**: The plan and do stage test now runs about 0.71s faster, down from 2.30s to 1.59s on average. All 437 command tests and the 35 required check -> Verify: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test` -> Next push: find the test with the most back-to-back launches left in the command tests and group the ones that change nothing.
- **2026-10-14 (capabilities)**: The earlier test speedup branch (252 commits that never merged) is now merged onto current master and pushed. The 3 required test files pass -> Verify: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test` -> Next push: run the 16 back-to-back CLI launches in the plan and do headless stage test together wherever a launch changes nothing.
- **2026-10-14 (capabilities)**: The backlog and clear-plan test now runs about 0.32s faster (2128ms to 1810ms), because five checks that change nothing run in two groups at -> Verify: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test`
- **2026-10-14 (capabilities)**: The headless JSON test now runs about 0.40s faster (1961ms to 1563ms), because its six refusal checks run in two groups at once instead of o -> Verify: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test` -> Next push: The backlog and clear-plan test launches the CLI 18 times in a row, the most of any test. Move its setup-only launches t
- **2026-10-14 (capabilities)**: The headless JSON test now skips one CLI launch that checked nothing, so it runs about 0.10s faster. The focused test passed 3 of 3 runs, an -> Verify: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test` -> Next push: In the same test, run the three claim and release refusals together, and the three finish refusals together. None of the

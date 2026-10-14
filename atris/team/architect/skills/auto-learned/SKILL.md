---
name: auto-learned
description: Verified patterns crystallized from passing runs for architect. Bounded to 5 newest patterns so context never bloats.
---

# Auto-Learned Verified Patterns

- **2026-10-14 (capabilities)**: The supervisor now requires checked tasks, streams live steps, and reports results, verified by 62 passing tests and the real command. Commi -> Verify: `git diff --check` -> Next push: show steps from members already working when the supervisor starts.
- **2026-10-14 (capabilities)**: I fixed the limit gap the reviewer caught, and the fix is pushed. A member that is already working now uses up one of the slots, so a limit  -> Verify: `git diff --check` -> Next push: show the team's working, idle, and done counts on the member board, so you can see them without the terminal.
- **2026-10-14 (behaviors)**: I fixed the gap the last review caught: naming the builder's own engine as its reviewer no longer works. Now, if you name the builder as its -> Verify: `git diff --check` -> Next push: show the review verdict on the member board so a failed review is visible at a glance.
- **2026-10-13 (behaviors)**: Saved and pushed the [update](atris/briefs/members-update-2026-10-13.md), covering all six items; the writing check passed, and `git diff -- -> Verify: `git diff --check` -> Next push: prove one hours-long member run through its final check and pushed change.
- **2026-10-13 (capabilities)**: I fixed the bug the checker found: updating a business project now exports the team, and I confirmed it by rerunning the checker's exact cas -> Verify: `git diff --check` -> Next push: prove each member appears exactly once in a live Codex and Cursor session.

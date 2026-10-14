---
name: auto-learned
description: Verified patterns crystallized from passing runs for executor. Bounded to 5 newest patterns so context never bloats.
---

# Auto-Learned Verified Patterns

- **2026-10-14 (capabilities)**: I checked this with tests and a real Codex run: members on Codex now show live steps the same way Claude members do. The branch is pushed bu -> Verify: `git diff --check`
- **2026-10-13 (behaviors)**: Finished member work now really does merge itself. A real member run, with its check passing and a second engine approving, pushed its branc -> Verify: `git diff --check` -> Next push: when a run doesn't name a reviewer, have it pick one that is a different engine from the worker. Right now the fallback
- **2026-10-13 (behaviors)**: When a member finishes a job and its check passes, the work can now merge itself if self-landing is switched on. Four new tests cover it wit -> Verify: `git diff --check` -> Next push: make the final push update an already-pushed branch safely, without overwriting anything newer on it.
- **2026-10-13 (environment)**: Atris 3.68.8 is live on npm. I asked npm for the current version myself, and it answers 3.68.8. -> Verify: `node --test test/member-export.test.js`
- **2026-10-13 (behaviors)**: Build ideas now go to executor instead of opus-overnight. I tested it on the exact scoreboard idea that went to the wrong member last night. -> Verify: `git diff --check` -> Next push: show the runner-up member and score in a dispatch dry run

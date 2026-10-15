---
name: auto-learned
description: Verified patterns crystallized from passing runs for architect. Bounded to 5 newest patterns so context never bloats.
---

# Auto-Learned Verified Patterns

- **2026-10-14 (behaviors)**: Pin reasons now stay on one report line, verified by 42 passing checks and real cleanup that retained the folder; committed and pushed. -> Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` -> Next push: prove multiline reasons through tidy and autopilot.
- **2026-10-14 (behaviors)**: Reap now clears a green landing scratch copy that was left behind once git is done in it, without needing force. The frozen checks pass (41  -> Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` -> Next push: next_push: once the guard pull request 1184 merges, point 1250 at master. Then let unattended autoland reaps clear an id
- **2026-10-14 (behaviors)**: Reap now labels a kept green landing scratch folder as a "green landing scratch copy" instead of showing a bare temp path. The frozen tests  -> Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` -> Next push: reap removes a leftover green landing scratch copy without force once git is idle in it.
- **2026-10-14 (behaviors)**: Green landing now says so when it keeps a scratch folder, naming the folder, the lock file, and its age. The frozen tests pass (41 of 41, ex -> Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` -> Next push: reap labels leftover green landing scratch folders by where they came from.
- **2026-10-14 (behaviors)**: The removal scanner now fails any plain folder delete that comes after git refused the same folder, unless a pin check runs first and can st -> Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` -> Next push: green landing's scratch cleanup uses the shared git hold check and names the lock file and age when it keeps a folder.

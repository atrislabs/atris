---
name: auto-learned
description: Verified patterns crystallized from passing runs for builder. Bounded to 5 newest patterns so context never bloats.
---

# Auto-Learned Verified Patterns

- **2026-10-14 (behaviors)**: I made the watch screen redraw as soon as a member's log changes, and a new real-terminal check proves it. The frozen verifier passes 84 of  -> Verify: `node --test test/member-board.test.js test/member-result.test.js` -> Next push: **Next tick (next_push):** give the job column its full room when the last step column is empty. In the 60-column probe,
- **2026-10-14 (behaviors)**: I added a check that the live stream keeps four more kinds of log change made the instant it opens. It fails on the code from before last ti -> Verify: `node --test test/member-board.test.js test/member-result.test.js` -> Next push: Probe the watch screen redrawing the instant a log is cut shorter or replaced, on a short window, so a stale row never l
- **2026-10-14 (behaviors)**: I fixed the live stream so it no longer loses a line written just as it opens. The full verifier passes 82 of 82, exit 0, and both new check -> Verify: `node --test test/member-board.test.js test/member-result.test.js` -> Next push: Make the watch screen and live stream share the same reading positions on resume, so a reader reconnecting with the last
- **2026-10-14 (behaviors)**: A failure reason written in Chinese now has a real-terminal check on narrow and short screens. It passes on the current board and fails on t -> Verify: `node --test test/member-board.test.js test/member-result.test.js` -> Next push: Prove live follow and watch agree when a member name itself contains wide characters, since names are cut in the compact
- **2026-10-14 (environment)**: I fixed eleven links in the map's member board row that had drifted onto unrelated lines, like a closing brace or a comment. I opened every  -> Verify: `node --test test/member-board.test.js test/member-result.test.js` -> Next push: Prove the watch screen keeps a row with a wide-character member failure reason whole in the compact narrow layout, since

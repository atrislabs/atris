# Four wide-character watch tests share one terminal harness

Four real-terminal tests for wide characters on narrow and short watch screens each repeated the same harness: open a pseudo-terminal of a set size, write progress logs, run the real watch command, read a frame, strip escapes, check it fits, press ctrl-c, check exit 0, clean up. That harness now lives once beside them, and each test passes only its cases. The test file is 106 lines shorter, a new case costs about ten lines instead of sixty, and the four copies can no longer drift apart. Test names and proof file variables are unchanged, so earlier receipts still rerun. No product code changed.

Map refs into the moved tests were repointed by matching each cited line's text in the new file, and a map note now points at the helper.

Files edited: test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 117 tests, 117 passed, 0 failed, 0 skipped, 58790ms.

Same behavior, same teeth:
- The converted tests print byte-identical terminal frames to the proofs saved before the change (names, short-screen footer, two-column footer); each runs `node bin/atris.js member board --watch` four times with exit 0.
- With name shortening and the footer fit both planted to count letters, all four converted tests failed (pass 0, fail 4, exit 1). Restored, they pass.

next_push: the first wide-character watch test streams a second frame after a write, so it kept its own harness; give the helper an optional write between frames and convert it too.

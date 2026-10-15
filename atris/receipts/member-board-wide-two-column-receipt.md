# A wide hidden member name fits the two-column footer by screen cells

Below 30 columns the board keeps only member and state. On a 3-row screen with a failed member shown, the footer names a hidden live member when it fits, else counts it. A Chinese name takes two cells per character, so a fit judged by letters would show the name two columns early and wrap the footer. The board already judges by cells; nothing tested this view. A new real-terminal test runs the watch command at both sides of two thresholds: the name shows from 21 columns, and the longer "more not shown" wording from 29, where each footer fills the window in cells though it is two letters shorter. No product code changed.

The test pushed later tests down; the three map refs below it moved with it, and the map guard passes.

Files edited: test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 117 tests, 117 passed, 0 failed, 0 skipped, 59095ms.

Teeth: with the footer fit planted to count letters, the 20-column screen showed the named footer 21 cells wide, and the test failed (exit 1). Restored, it passed.

Real terminal output (`ATRIS_BOARD_WIDE_TWO_COLUMN_PROOF=<file> node --test --test-name-pattern="two-column footer by screen cells" test/member-board.test.js`, exit 0):

```
command: node bin/atris.js member board --watch (20 columns, 3 rows)
member   state
builder  timed out
2 hidden (1 running)
exit: 0
command: node bin/atris.js member board --watch (21 columns, 3 rows)
member   state
builder  timed out
2 hidden (后端 quiet)
exit: 0
command: node bin/atris.js member board --watch (28 columns, 3 rows)
member   state
builder  timed out
2 hidden (后端 quiet)
exit: 0
command: node bin/atris.js member board --watch (29 columns, 3 rows)
member   state
builder  timed out
2 more not shown (后端 quiet)
exit: 0
proof exit: 0
```

next_push: the three wide-character watch tests repeat the same terminal harness, about 35 lines each; share one helper so a fourth case costs a few lines, with grep proof each test still runs the real watch command.

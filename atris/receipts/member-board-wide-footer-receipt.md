# Wide hidden member names fit the short-screen footer by screen cells

On a screen too short for every row, the footer names up to three hidden live members when they fit, else counts them. Names in Chinese or with emoji take two screen cells per character, so a fit judged by letters would wrap the footer and push the header off a watch screen. The board already judges by screen cells; nothing tested it. A new real-terminal test runs the watch command at each side of two thresholds: names show at 61 columns on a 3-row screen and at 47 on a 4-row screen, each footer exactly as wide as its window though 12 and 10 letters shorter; one column narrower, a count takes their place. No product code changed.

The test pushed later tests down; the three map refs below it moved with it in the same change, and the map guard passes.

Files edited: test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 116 tests, 116 passed, 0 failed, 0 skipped, 58254ms.

Teeth: with the footer fit planted to count letters, the 61-column screen picked a footer 69 cells wide that would wrap, and the test failed (exit 1). Restored, it passed.

Real terminal output, with the rocket emoji written as [rocket] here (`ATRIS_BOARD_WIDE_FOOTER_PROOF=<file> node --test --test-name-pattern="short-screen footer by screen cells" test/member-board.test.js`, exit 0):

```
command: node bin/atris.js member board --watch (61 columns, 3 rows)
member   state   last result  ago     job  last step
builder  failed  timed out    6m ago  fix  -
3 hidden (后端 working, [rocket]部署 working, 前端开发工程师 quiet)
exit: 0
command: node bin/atris.js member board --watch (60 columns, 3 rows)
member   state   last result  ago     job  last step
builder  failed  timed out    6m ago  fix  -
3 more not shown (3 running), the window is too short
exit: 0
command: node bin/atris.js member board --watch (47 columns, 4 rows)
member   state        last result  ago     job
后端     working      -            5s ago  api
builder  done failed  timed out    6m ago  fix
2 hidden ([rocket]部署 working, 前端开发工程师 quiet)
exit: 0
command: node bin/atris.js member board --watch (46 columns, 4 rows)
member   state        last result  ago     job
后端     working      -            5s ago  api
builder  done failed  timed out    6m ago  fix
2 more not shown (2 running)
exit: 0
proof exit: 0
```

next_push: the two-column board at 18 to 29 columns on a 3-row screen with wide hidden names; prove in a real terminal the footer stays one line and the count takes over where names stop fitting.

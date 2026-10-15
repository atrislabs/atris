# Wide member names shorten by screen cells on narrow watch screens

A member name in Chinese or with emoji takes two screen cells per character. The compact board views at 18 to 36 columns already shorten names by screen cells, and nothing tested it. A new real-terminal test runs the watch command with two such names beside an English one, at 18, 22, 29, and 36 columns, and checks every board line exactly. No line goes past the window and no character splits: at 18 columns a Chinese name shows one character and dots in five of six cells, since a second character would overflow. No product code changed.

Two smaller fixes rode along. The test pushed later tests down, and the map guard from earlier today caught three refs that drifted; they now point at their tests. The older guard said "past the end" for a blank cited line; it now shows the blank line.

Files edited: test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 115 tests, 115 passed, 0 failed, 0 skipped, 57460ms.

Teeth: with name shortening planted to count letters instead of screen cells, the test failed at 18 columns (a name eight cells wide in a six-cell column, exit 1). Restored, it passed.

Real terminal output, with the rocket emoji written as [rocket] here (`ATRIS_BOARD_WIDE_NAME_TRIM_PROOF=<file> node --test --test-name-pattern="member names in wide" test/member-board.test.js`, exit 0):

```
command: node bin/atris.js member board --watch (18 columns, 8 rows)
member  state
bui...  signed out
[rocket]...   ok
前...   timed out

ctrl-c to stop

exit: 0
command: node bin/atris.js member board --watch (22 columns, 8 rows)
member      state
builder     signed out
[rocket]部署...   ok
前端开...   timed out

ctrl-c to stop

exit: 0
command: node bin/atris.js member board --watch (29 columns, 8 rows)
member          state
builder         signed out
[rocket]部署小组成员  ok
前端开发工程师  timed out

updates 3s, ctrl-c to stop

exit: 0
command: node bin/atris.js member board --watch (36 columns, 8 rows)
member          state   last result
builder         failed  signed out
[rocket]部署小组成员  ok      ok
前端开发工程师  failed  timed out

redraws every 3s, ctrl-c to stop

exit: 0
proof exit: 0
```

next_push: hidden live members named in the short-screen footer ("busy working, scout quiet") with Chinese or emoji names; prove the footer stays one line by screen cells in a real terminal.

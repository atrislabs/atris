# A one-row board says who is hidden and why

On a watch screen only one row tall, the board drew just its column headings, so it said nothing: not that members were hidden, not that one had failed. The receipt that first fit the board to short screens listed this as a known limitation. Now a one-row board is the line that counts who did not fit, failures first, like "3 hidden (1 failed, timed out)". Two and three rows keep the heading as before. Three tests that pinned headings-only at one row now expect the count line, and one of them is renamed to match.

Files edited: lib/member-board.js; test/member-board.test.js; atris/MAP.md (board row wording, 15 refs moved); atris/refs/MAP-NOTES.md (short-screen note, 48 refs moved); atris/team/builder/logs/2026-10-14.md; this receipt. Also left two cards in the local atris/status/for-you.md: keep or revert this change, and whether the narrowest board should show short member names.

Real watch command in a pseudo-terminal one row tall, three members (one failed, one working, one finished ok):

```
before the fix
command: node bin/atris.js member board --watch (12 columns, 1 rows)
state
command: node bin/atris.js member board --watch (30 columns, 1 rows)
member  state  last result
command: node bin/atris.js member board --watch (80 columns, 1 rows)
member  state  last result  ago  job  last step

after the fix
command: node bin/atris.js member board --watch (12 columns, 1 rows)
3 hidden
exit: 0
command: node bin/atris.js member board --watch (30 columns, 1 rows)
3 hidden (1 failed, timed out)
exit: 0
command: node bin/atris.js member board --watch (80 columns, 1 rows)
3 more not shown (1 failed, timed out, ana working), the window is too short
exit: 0
```

Teeth: the three updated tests, `node --test --test-name-pattern="one-line board counts|whole screen in one to three|taller watch window" test/member-board.test.js`, fail on the old board code (exit 1, 0 passed, 3 failed) and pass on the new code (exit 0, 3 passed).

Verify command: `node --test test/member-board.test.js test/member-result.test.js`, run last, after every file was written and staged.

next_push: a one-row board with older runs hidden and nobody current shows "idle. 2 older"; check that the real watch command at one row says the same, and that a resize from one row to three brings the heading back on the next frame.

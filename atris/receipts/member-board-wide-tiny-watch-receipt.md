# The watch screen under 13 columns is pinned in a real terminal

The live watch screen was proven at 18 columns and up with wide-character member names, and the 1- and 2-column fix from two ticks ago was proven only outside the suite. A new test runs the real watch command in a pseudo-terminal at 1, 2, 3, 5, 6, and 12 columns on a tall screen and at 1, 2, and 12 on a short one, with Japanese and Korean member names, and asserts every line of each frame. Below 13 columns the board keeps one column of states in order, since a cut wide name cannot tell rows apart. Below 3 columns a cut keeps only the dots that fit. The hint shows from 6 columns on a tall screen. A probe across every width from 1 to 12 at both heights found no line past the window. No product code changed.

Files edited: test/member-board.test.js; atris/MAP.md and atris/refs/MAP-NOTES.md (6 refs into the board tests moved down 28 lines, plus one new note); atris/team/builder/logs/2026-10-14.md; this receipt.

Real terminal output, `ATRIS_BOARD_WIDE_TINY_PROOF=<file> node --test --test-name-pattern="under 13 columns" test/member-board.test.js` (exit 0, 1 passed), excerpt:

```
command: node bin/atris.js member board --watch (2 columns, 12 rows)
..
..
ok
..


command: node bin/atris.js member board --watch (6 columns, 12 rows)
state
wor...
ok
failed

ctrl-c

proof exit: 0
```

Teeth: with the under-3-columns fix taken out of the board code, the same test failed (exit 1) on the 1-column frame of three dots per line. The board code was restored from git afterward.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`, run last, after every file was written and staged.

next_push: the one-column state board names nobody; when exactly one row is shown, or every state differs, try the shortest unique name prefix that fits so a person can still tell whose row is whose.

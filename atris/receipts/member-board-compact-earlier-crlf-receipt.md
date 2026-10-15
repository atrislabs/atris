# The short watch screen shortens a hidden earlier failure footer in order, for LF and CRLF logs

The terminal proof for this footer had gone stale and failed on its own: a 7-row screen now fits all four of its members, so nothing hid and no footer appeared. It now uses eight members, with six finished ones fresher than the busy member so the busy one hides. It judges the first frame alone and checks three widths for LF and CRLF logs. The suite runs it, so it cannot go stale silently again. Two drifted refs in its navigation row now point at the right lines. No product code changed.

Files edited: atris/runs/member-board-compact-earlier-proof.py; test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Before: `python3 -I atris/runs/member-board-compact-earlier-proof.py` exit 1 (footer never drawn).

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 111 tests, 111 passed, 0 failed, 0 skipped, 58939ms.

The new check has teeth: with the trailing CR removal taken out of the line parser, the LF screens still passed and the first CRLF screen failed (pass 0, fail 1, exit 1).

Real terminal run, `python3 -I atris/runs/member-board-compact-earlier-proof.py "$(which node)"`, exit 0 in 1.6s, all six screens exit 0. Excerpt:

```
command: node bin/atris.js member board --watch (CRLF logs, 47 columns, 7 rows)
member  state   last result
ok1     ok      ok
ok2     ok      ok
ok3     ok      ok
ok4     ok      ok
broke   failed  engine error
3 more not shown (1 earlier failure, timed out)
exit: 0
3 more not shown (1 with earlier failure, timed out)
3 more not shown (1 earlier failure, timed out)
3 more not shown (1 earlier failure)
hidden earlier failure footer drops "with", then the reason, for LF and CRLF logs
```

next_push: nine navigation refs into the board tests between lines 1695 and 2026 point mid-test; repoint each at the test it describes.

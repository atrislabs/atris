# The short watch screen names the engine a hidden member signed out of, for LF and CRLF logs

The terminal proof for hidden sign-in failures had gone stale and failed on its own: with two members a 5-row screen now shows both, so no summary appeared, and it judged every redraw as one frame. It now uses seven members so three hide, judges the first frame alone, pauses before ctrl-c like the stop proof, and runs every width for LF and CRLF logs. The suite runs it, so it cannot go stale silently again. No product code changed.

Files edited: atris/runs/member-board-earlier-engine-proof.py; test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Before: `python3 -I atris/runs/member-board-earlier-engine-proof.py` exit 1 (width assertion on joined redraws, no summary line).

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 110 tests, 110 passed, 0 failed, 0 skipped, 61205ms.

The new check has teeth: with the trailing CR removal taken out of the line parser, the LF screens still passed and the first CRLF screen failed (pass 0, fail 1, exit 1).

Real terminal run, `python3 -I atris/runs/member-board-earlier-engine-proof.py "$(which node)"`, exit 0 in 2.9s, all eight screens exit 0. Excerpt:

```
command: node bin/atris.js member board --watch (CRLF logs, 80 columns, 5 rows)
member  state    last result  run       ago      job          last step
scout   working  -            codex 5s  5s ago   another job  -
ok1     done ok  -            -         16s ago  -            -
ok2     done ok  -            -         17s ago  -            -
3 more not shown (1 with earlier failure, signed out of claude)
exit: 0
command: node bin/atris.js member board --watch (CRLF logs, 40 columns, 5 rows)
member  state    last result
scout   working  -
ok1     ok       ok
ok2     ok       ok
3 hidden (1 earlier failure, signed out)
exit: 0
command: node bin/atris.js member board --watch (CRLF logs, 18 columns, 5 rows)
member  state
scout   working
ok1     ok
ok2     ok
3 hidden
exit: 0
hidden sign-in failure names its old engine where it fits, for LF and CRLF logs
```

next_push: the sibling compact earlier-failure terminal proof in atris/runs is not run by the suite either; run it, and if it is stale, repair it and wire it in the same way.

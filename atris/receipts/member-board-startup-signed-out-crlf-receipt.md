# Signed out runs written with Windows-style lines keep their sign-in fix

A finished run that signed out, written with CRLF line endings, now has a real-command check. The plain board, the JSON board, and the opening snapshot of live follow all keep the engine name and the "sign in to claude, then run it again" fix. No product code changed; this tick is proof.

Plan: CRLF start with pid and engine tag, a step, a signed out finish -> plain board -> JSON board -> follow snapshot -> clean interrupt.

Files edited: test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 109 tests, 109 passed, 0 failed, 0 skipped, 62293ms.

The new check has teeth: with the trailing CR removal taken out of the line parser, it failed (pass 0, fail 1, exit 1). With current code it passed (exit 0).

Real CLI run from a temp progress folder holding one CRLF log:

```
$ ATRIS_PROGRESS_DIR=<tmp> node bin/atris.js member board
member  state        last result                 alive  engine  running for  ago     job                    last step
locked  done failed  failed (signed out) 1m ago  no     claude  -            1m ago  ship the pricing page  sign in to claude, then run it again
exit 0
```

next_push: prove a member that signed out of one engine under CRLF and is now running on another still names the engine it signed out of in the hidden-row summary.

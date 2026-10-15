# Each proof file variable belongs to one board test

Some board tests save their real terminal output to a file named by an environment variable, so a receipt can keep it. Two tests sharing one variable overwrite each other when run together. A scan found a live case: the live follow shrink test and the newer watch shrink test both wrote one variable, and the follow test's receipt reruns the whole suite with it set, so a rerun kept the watch test's frames instead. The watch test now has its own variable, and a new check fails the suite whenever two tests write the same one, naming the variable and both tests. No product code changed.

Files edited: test/member-board.test.js; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 118 tests, 118 passed, 0 failed, 0 skipped, 60095ms.

Teeth: with the old shared variable put back, the check failed (exit 1):

```
+   'ATRIS_BOARD_SHRINK_PROOF is written by the tests at lines 2345, 3578'
```

Real run of both shrink tests with both variables set (exit 0, 2 passed): the follow proof file now opens with the follow command and its JSON snapshot, and the watch proof file opens with `command: node bin/atris.js member board --watch (100x8 shrunk to 40x6, resize first)`.

next_push: a check that every proof variable a receipt's rerun line names is still written by a board test, so renaming one cannot leave a receipt pointing at nothing.

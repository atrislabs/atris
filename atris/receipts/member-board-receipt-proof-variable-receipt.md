# Every proof variable a receipt names is still written by a board test

Receipts keep a board test's real terminal output by rerunning the suite with a proof file variable set. If a test renames its variable, the receipt's rerun still passes but saves nothing, and nobody notices. A new check reads every checked-in receipt under atris/receipts and atris/runs, collects each proof variable it names, and fails if no board test writes that name, listing the receipt and the name. All eight receipts that name one point at a live variable today. No product code changed.

Files edited: test/member-board.test.js; atris/refs/MAP-NOTES.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 119 tests, 119 passed, 0 failed, 0 skipped.

Teeth: with a made-up proof variable added to the wide footer receipt's rerun line, the check failed (exit 1) and named it:

```
+   'atris/receipts/member-board-wide-footer-receipt.md names ATRIS_BOARD_GONE_PROOF'
```

The receipt was restored from git afterward and the check passes again.

next_push: check that each receipt's rerun command, when it names a single test, names a test title that still exists in the board suite.

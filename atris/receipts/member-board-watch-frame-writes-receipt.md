# The last wide-character watch test joins the shared terminal harness

The shared terminal harness for the wide-character watch tests now takes optional log writes and returns one more frame after each. That let the first of these tests, which streams an emoji step in while the board watches, drop its own copy of the harness. All five now share it; the test file is 33 lines shorter.

Two fixes came with it. The harness held a literal replacement character where its escape was meant; it is the escape again, and a scan shows no literal invisible characters left in the file. And the wide-name test from earlier today reused a proof file variable an older live follow test already owned, so running both overwrote one proof with the other; it now has its own name, and its receipt's rerun line matches. No product code changed.

Files edited: test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/receipts/member-board-wide-names-receipt.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 117 tests, 117 passed, 0 failed, 0 skipped, 63065ms.

Same behavior, same teeth:
- The converted streaming test prints byte-identical frames to its saved output from before the change: two 80x6 frames running `node bin/atris.js member board --watch`, then exit 0. The other four match their saved proofs too.
- With every character planted to count as one screen cell, all five tests failed (pass 0, fail 5, exit 1). Restored, they pass.

next_push: a check that fails when two tests write the same proof file variable, so a shared name cannot silently overwrite a receipt's proof again.

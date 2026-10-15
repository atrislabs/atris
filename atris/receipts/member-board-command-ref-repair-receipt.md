# Map refs into the member command land on what they describe again

Twenty-four line refs from the map files into commands/member.js had drifted, most by 20 to 400 lines, onto closing braces, blank lines, or unrelated code. They cover idea dispatch, starting a member run, parking, results, reports, tidy, export, wake, install, auto-merge, the run check outcome, and the up command. Each now lands on what its sentence describes. The target came from history: the line at the cited number in the commit that wrote the ref, then found by its text today. Five were loose even when written (the run check outcome, quote handling, claim send, tidy, and install); those were checked against the sentence and pointed at the statement it names. Three refs were already right and stayed. No product code changed.

Most of these refs belong to other features, so the board suite guards only its own: a new check fails when the board row's ref into the member command stops landing on the line that hands off to the board.

Files edited: atris/MAP.md; atris/refs/MAP-NOTES.md; test/member-board.test.js; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 114 tests, 114 passed, 0 failed, 0 skipped, 56963ms.

The new check was tested against a real drift:

```
$ node --test --test-name-pattern='board hand-off' test/member-board.test.js   (board row ref moved from 11473 to 11472)
AssertionError [ERR_ASSERTION]: atris/MAP.md board row cites commands/member.js:11472
exit 1
$ (ref restored)
exit 0
```

A history trace over every non-function ref into the member command after the fix shows each on the statement its sentence names.

next_push: a member name in Chinese or with emoji in the compact board view at 18 to 29 columns; prove in a real terminal that the name trims by screen cells and the state stays whole.

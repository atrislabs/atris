# Map refs into the board code land on their functions again, and a guard keeps them there

Thirty-six line refs from the map files into lib/member-board.js had drifted. Most sat one line high, on the comment above a function, after code was added above them. Three in the main map row pointed far off (stop, follow, and the board command, each moved by 60 to 80 lines). Each now points at the first line of the function it describes. The target came from the function the map names beside the ref, or from history for the three unnamed ones: what sat at the cited line in the commit that wrote the ref. One ref pointed inside the watch loop; it now names the board command and cites its first line, since a line inside a body drifts on every edit. A new check fails the suite when any ref drifts again and names it. No product code changed.

Files edited: atris/MAP.md; atris/refs/MAP-NOTES.md; test/member-board.test.js; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 113 tests, 113 passed, 0 failed, 0 skipped, 56574ms.

The guard was run on the drifted map before the fix, and it named all 36 refs (exit 1). After the fix both map guards pass. A planted one-line drift fails it again:

```
$ node --test --test-name-pattern='board code lands' test/member-board.test.js   (one followBoard ref moved from 888 to 887)
+   'atris/refs/MAP-NOTES.md cites line 887 as followBoard(): // snapshot built from those same bytes neither misses nor r'
exit 1
$ (ref restored)
exit 0
```

next_push: 27 of 38 map refs into commands/member.js do not land on a function or constant line; triage which are intentional dispatch rows, repoint the drifted ones, and extend the guard to that file.

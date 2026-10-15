# Map refs into the board tests land on their tests again, and a guard keeps them there

Thirty-eight line refs from the map files into the board tests had drifted into the middle of other tests, some by hundreds of lines, as tests were added above them. Each now points at the test it describes. The target came from history: the test enclosing the cited line in the commit that wrote the ref, then found by name today. Three needed a hand fix: two named a follow test renamed since, and one row on live terminal resize had matched a footer test. A new check fails the suite when any ref drifts again and names it. No product code changed.

Files edited: atris/MAP.md; atris/refs/MAP-NOTES.md; test/member-board.test.js; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. 112 tests, 112 passed, 0 failed, 0 skipped, 57712ms.

The guard has teeth. A first version also accepted constants inside test bodies and let a drifted ref through; the tightened one fails on the same drift:

```
$ node --test --test-name-pattern='every map line ref' test/member-board.test.js   (one MAP.md ref moved from 945 to 950)
+   "atris/MAP.md cites line 950: const w = new (require('node:events'))();"
pass 0, fail 1, exit 1
$ (ref restored)
pass 1, fail 0, exit 0
```

next_push: the code refs into lib/member-board.js in the same map files have drifted too, mostly by one line (readTail at 31 for 32, followBoard at 887 for 888, renderBoard at 309 and 311 for 310); repoint them and extend the guard to function refs.

# Tiny terminal watch proof

Watch mode now fits one to three terminal rows; real command exit 0 at each height and frozen checks exit 0.

Files: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-watch-height-proof.py and this receipt.
Plan: tiny terminal -> omit hint and final newline -> use whole height.

Verify: `node --test test/member-board.test.js test/member-result.test.js`
Output: tests 41; pass 41; fail 0; cancelled 0; skipped 0; todo 0.
Exit: 0.

Real command: `python3 atris/runs/member-board-watch-height-proof.py`
Invokes: `node bin/atris.js member board --watch` in real 80-column terminals.
Output excerpt, one row:
```
member  state  last result  ago  job  last step
```
Output excerpt, two rows:
```
member  state  last result  ago  job  last step
4 more not shown (3 failed, all timed out, 1 stopped), the window is too short
```
Output excerpt, three rows:
```
member  state        last result                ago     job  last step
f1      done failed  failed (timed out) 1m ago  1m ago  job  -
3 more not shown (2 failed, all timed out, 1 stopped), the window is too short
```
Exit: 0 at each height. Frame heights: exactly 1, 2, 3 rows. No trailing newline scrolls the header. Regression also verifies resizing to six rows restores the hint.

Limitation: a one-row terminal shows only the header. No change to mission policy or dependencies.
next_push: Keep the watch hint on one line in narrow terminals by shortening it to fit the available width.
layer: behaviors

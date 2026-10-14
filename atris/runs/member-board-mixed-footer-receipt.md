# Mixed hidden counts stay whole

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: footer still too wide -> drop whole counts from the end behind an ellipsis -> no count is cut mid-word.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 47; pass 47; fail 0.

Real surface: python3 atris/runs/member-board-mixed-footer-proof.py
Invokes: node bin/atris.js member board --watch in real terminals with 7 rows, one shown failure and four hidden members (two failed, one stopped, one with no result).
Exit: 0 for all five commands and the proof script.
Output excerpts:
80 columns: 4 more not shown (2 failed, 1 stopped, 1 ended with no result)
44 columns: 4 hidden (2 failed, 1 stopped, 1 no result)
40 columns: 4 hidden (2 failed, 1 stopped, ...)
30 columns: 4 hidden (2 failed, ...)
24 columns: 4 hidden (2 failed, ...)

Before: the same board cut a count in half from 43 columns down, for example 1 stopp... at 30 columns.
Progress: one regression added, one old check updated from the half-cut form to the whole-count form, 47 checks passing, five terminal widths proven. Wide output keeps its wording.
next_push: Keep the older-runs note from cutting a hidden count when both share a narrow footer.
layer: behaviors

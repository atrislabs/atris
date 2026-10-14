# One hidden live member is named

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: footer picked exactly as before -> if one live member is hidden, try its name by dropping "the window is too short" or shortening the older-runs note -> keep the plain footer if it still does not fit.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 50; pass 50; fail 0.

Real surface: python3 atris/runs/member-board-lone-live-proof.py
Invokes: node bin/atris.js member board --watch in real terminals with 7 rows, one working member and three finished ones (two failed, one stopped).
Exit: 0 for all four commands and the proof script.
Output excerpts:
100 columns: 3 more not shown (1 failed, bad exit 2, 1 stopped, busy working), the window is too short
80 columns: 3 more not shown (1 failed, bad exit 2, 1 stopped, busy working)
50 columns: 3 more not shown (1 failed, bad exit 2, 1 stopped)
30 columns: 3 hidden (1 failed, 1 stopped)

Before, same board from the last commit:
100 columns: 3 more not shown (1 failed, bad exit 2, 1 stopped), the window is too short
80 columns: 3 more not shown (1 failed, bad exit 2, 1 stopped), the window is too short
50 and 30 columns: unchanged.

Caught on the way: the first version made the name just another count, which at 80 columns with older runs dropped the failure reason "bad exit 2" to keep the name. The footer now picks its counts and reasons first and lets the name take only wording.
Progress: the one running member is named instead of hidden in a bare count wherever its name costs no failure detail. One regression added; four older checks now expect the name. 50 checks passing, four terminal widths proven.
next_push: Name the hidden live members when two or three are hidden and their names fit, so a short screen during a busy run says who is still going.
layer: behaviors

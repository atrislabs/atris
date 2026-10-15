# Older-runs note never hides a current member

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: short screen sized for rows plus the older note -> size it for current rows only -> the note takes a spare row or waits.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 49; pass 49; fail 0.

Real surface: python3 atris/runs/member-board-older-room-proof.py
Invokes: node bin/atris.js member board --watch in real 80-column terminals of 3, 4, 5, 6 and 7 rows, with one working member, one failed member, and two runs finished over an hour ago.
Exit: 0 for all five commands and the proof script.
Output excerpts:
6 rows: busy working, broke done failed engine error, then the redraw hint; no member hidden.
7 rows: both members, then: 2 finished over an hour ago, hidden. --all shows them

Before, same board with three board lines (the 6-row watch screen):
member  state        last result   ago     job  last step
broke   done failed  engine error  1m ago  -    -
1 more not shown. 2 finished over an hour ago, hidden. --all shows them

Note: the premise of the previous next_push was wrong. Two and three line boards already show the footer; only a one-line board drops it, which it must to keep the header. The real gap found while checking was this one.
Progress: on short screens, the working member is no longer swapped out for a note about old runs. One regression added, 49 checks passing, five terminal heights proven.
next_push: When a short screen hides members, say which member is hidden first if it is the only live one, so a lone working run is never a bare count.
layer: behaviors

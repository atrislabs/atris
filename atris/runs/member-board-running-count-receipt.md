# Hidden running members are counted when names do not fit

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: live names do not fit, or four or more are hidden -> say "N running" -> try shorter labels too -> still never at the cost of a failure count or reason.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 50; pass 50; fail 0.

Real surface: python3 atris/runs/member-board-running-count-proof.py
Invokes: node bin/atris.js member board --watch in real terminals with 7 rows, three running members (one quiet) and three finished ones (two failed, one stopped).
Exit: 0 for all four commands and the proof script.
Output excerpts:
100 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped, busy working, also working, scout quiet)
80 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped, 3 running)
60 columns: 5 hidden (1 failed, bad exit 2, 1 stopped, 3 running)
50 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped)

Before, same board from the last commit:
80 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped), the window is too short
60 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped)

Every updated check only gained a running count or swapped "more not shown" for "hidden"; no failure count or reason was dropped.
Seen, not changed: with an older-runs note at 80 columns the plain footer already drops a failure reason before it shortens that note. That order predates this change.
Progress: hidden running members are now named or counted from 54 columns up on this board, where before they were only part of the total. Eleven older checks updated and two added, 50 tests passing, four terminal widths proven.
next_push: Shorten the older-runs note before dropping a failure reason, so "bad exit 2" survives beside older runs at 80 columns.
layer: behaviors

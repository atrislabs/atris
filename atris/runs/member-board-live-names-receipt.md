# Up to three hidden live members are named

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: one named live member -> up to three, each with its own state -> all names or none -> still only taking room from wording.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 50; pass 50; fail 0.

Real surface: python3 atris/runs/member-board-live-names-proof.py
Invokes: node bin/atris.js member board --watch in real terminals with 7 rows, three running members (one quiet) and three finished ones (two failed, one stopped).
Exit: 0 for all three commands and the proof script.
Output excerpts:
120 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped, busy working, also working, scout quiet), the window is too short
100 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped, busy working, also working, scout quiet)
80 columns: 5 more not shown (1 failed, bad exit 2, 1 stopped), the window is too short

Before, same board from the last commit, at 120 and 100 columns:
5 more not shown (1 failed, bad exit 2, 1 stopped), the window is too short

Progress: a short screen during a busy run now says who is still going, for up to three runs, with no failure detail given up. All or none, so a partly named list never makes a live run look missing; four or more stay in the total. The one-name check became a two- and three-name check, 50 checks passing, three terminal widths proven.
next_push: When live names do not fit, count them as "2 working" so running members are never only part of the total.
layer: behaviors

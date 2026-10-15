# Older-runs note gives way to hidden counts

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: footer too wide with an older-runs note -> shorten that note in whole steps, then drop it -> only then drop hidden counts from this screen.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 48; pass 48; fail 0.

Real surface: python3 atris/runs/member-board-older-note-proof.py
Invokes: node bin/atris.js member board --watch in real terminals with 7 rows, one shown failure, four hidden members (two failed, one stopped, one with no result), and two runs finished over an hour ago.
Exit: 0 for all five commands and the proof script.
Output excerpts:
100 columns: 4 more not shown (2 failed, 1 stopped, 1 no result). 2 older runs hidden, --all shows them
60 columns: 4 hidden (2 failed, 1 stopped, 1 no result). 2 older hidden
50 columns: 4 hidden (2 failed, 1 stopped, 1 no result)
46 columns: 4 hidden (2 failed, 1 stopped, 1 no result)
30 columns: 4 hidden (2 failed, ...)

Before, same board from the last commit:
60 columns: 4 hidden (2 failed, ...). 2 older runs hidden, --all show...
50 columns: 4 hidden (2 failed, ...). 2 older runs hidden, ...
46 columns: 4 hidden (2 failed, ...). 2 older runs hidd...

Progress: hidden counts beside an older note now stay complete down to 43 columns instead of losing counts below 82. One regression added; one old check that expected a cut footer now expects the whole shorter note. 48 checks passing, five terminal widths proven.
next_push: Show the older-runs note in the one-to-three row watch screens that now drop the footer entirely.
layer: behaviors

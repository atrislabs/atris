# Failure reasons outlast the older-runs note

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: footer with a failure reason and an older-runs note is too wide -> shorten that note, then drop it -> only then drop the reason.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 50; pass 50; fail 0.

Real surface: python3 atris/runs/member-board-reason-over-older-proof.py
Invokes: node bin/atris.js member board --watch in real terminals with 6 rows, three finished members (two failed, one stopped) and two runs finished over an hour ago.
Exit: 0 for all four commands and the proof script.
Output excerpts:
100 columns: 2 more not shown (1 failed, bad exit 2, 1 stopped). 2 older runs hidden, --all shows them
80 columns: 2 hidden (1 failed, bad exit 2, 1 stopped). 2 older, --all shows them
60 columns: 2 hidden (1 failed, bad exit 2, 1 stopped). 2 older hidden
44 columns: 2 hidden (1 failed, bad exit 2, 1 stopped)

Before, same board from the last commit:
80 columns: 2 more not shown (1 failed, 1 stopped). 2 older runs hidden, --all shows them
60 columns: 2 hidden (1 failed, 1 stopped). 2 older, --all shows them

Progress: beside older runs, the hidden failure reason now stays down to 44 columns instead of vanishing below 100. Three older checks updated to keep the reason, three added, 50 tests passing, four terminal widths proven.
next_push: Name a hidden stopped member's reason too, like "1 stopped by hand" against "1 stopped, process gone", if the progress log tells them apart.
layer: behaviors

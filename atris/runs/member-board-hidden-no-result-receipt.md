# Hidden missing-result counts stay whole

Changed lib/member-board.js and test/member-board.test.js; updated atris/MAP.md, atris/refs/MAP-NOTES.md and atris/team/builder/logs/2026-10-14.md.

Plan: hidden missing results -> shorter whole label -> count fits.

Verify: node --test test/member-board.test.js test/member-result.test.js
Exit: 0
Output: tests 46; pass 46; fail 0; cancelled 0; skipped 0; todo 0.

Real surface: python3 atris/runs/member-board-hidden-no-result-proof.py
Invokes: node bin/atris.js member board --watch in real terminals with 7 rows.
Exit: 0 for all four commands and the proof script.
Output excerpts:
80 columns: 3 more not shown (3 ended with no result), the window is too short
41 columns: 3 more not shown (3 ended with no result)
31 columns: 3 more not shown (3 no result)
22 columns: 3 hidden (3 no result)

Progress: one regression added, 46 checks passing, four terminal widths proven. The mixed stopped/missing count stays whole at 33 columns. Wide output keeps its wording.
Initial proof used non-watch mode, which does not limit height; corrected the proof to watch mode. Initial mixed-count test allocated 32 columns for 33 characters; corrected to the exact boundary.
Mission task attachment was locked by the running parent process; used a separate claimed task, without changing mission policy.
next_push: Keep mixed failure and missing-result footer counts readable below 33 columns.
layer: behaviors

Review handoff: the task runner resolved plain node to a different runtime and failed (30 pass, 3 fail, 13 cancelled); the same required suite passed when pinned to /opt/homebrew/bin/node (Node 25), exit 0. Proof is in Review and requires independent approval; no acceptance performed. Brain compile stayed plan only, exit 2.

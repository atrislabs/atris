Watch hints now stay whole at narrow widths; the real CLI passed at five widths and all 41 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-watch-width-proof.py, atris/runs/member-board-watch-width-receipt.md.
Commands run: atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-improving-atris-mem-187401de; atris mission goal --json; atris task list; atris task new; atris task claim BCI-8 --as builder; atris task note BCI-8; git status --short; git diff; atris brain compile --root . (plan only, exit 2).

Verify: node --test test/member-board.test.js test/member-result.test.js
Exact output excerpt:
ℹ tests 41
ℹ pass 41
ℹ fail 0
Exit: 0

Real surface: python3 atris/runs/member-board-watch-width-proof.py
Invoked: node bin/atris.js member board --watch
Output excerpts:
28 columns: updates 3s, ctrl-c to stop
24 columns: ctrl-c to stop
14 columns: ctrl-c to stop
6 columns: ctrl-c
5 columns: hint omitted
Each CLI invocation exited 0. Proof script exited 0.

Progress: five narrow widths keep the hint within one line; no new dependencies. The board's minimum columns still overflow these extreme widths, which is outside this hint-only slice.
next_push: Fit the board's essential columns within terminals below 43 columns.
Review handoff: the task runner's login shell picked Node 20.18.0, below the CLI minimum, so two handoff attempts failed. The direct frozen check ran on Node 25.6.1 and passed. The handoff then ran /opt/homebrew/Cellar/node/25.6.1/bin/node --test test/member-board.test.js test/member-result.test.js, exit 0, and moved the task to Review. It needs independent review because the absolute command cannot be automatically certified. No mission settings changed.
Review artifact: atris/runs/2026-10-14-task-bci-8-2026-10-14T20-32-15-541Z.json.
Landing: committed and pushed successfully.
layer: behaviors

# Idle board width proof

Idle-board messages now fit small terminals, verified by the real command in five layouts and 95 passing tests, exit 0.

Files changed: lib/member-board.js; test/member-board.test.js; atris/receipts/member-board-idle-width-proof.py; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt.

Real surface command: python3 atris/receipts/member-board-idle-width-proof.py
The script runs node bin/atris.js member board --watch in a real pseudo-terminal and resizes it.
Actual output:
```text
18x1: idle. 3 older
4x2: idle
30x3: idle. 3 older runs hidden
60x3: nobody is working. 3 older runs hidden. --all shows them
120x3: nobody is working right now. 3 finished over an hour ago, hidden. --all shows them
exit: 0
idle board fits; older-run count and full detail return after resize
```

Rerun: node --test test/member-board.test.js test/member-result.test.js
Actual output excerpt (Node v25.6.1):
```text
ℹ tests 95
ℹ suites 0
ℹ pass 95
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 33898.953375
```
Exit code: 0.

Progress: two regression checks added; 360 width/count combinations checked; five live layouts fit. Full wording returns after widening; pipes keep the original full message. At widths too small for a whole count, the message says idle, then a dash at one to three columns.

Committed and pushed the focused change to origin. Existing TODO and earlier member-log edits were preserved. Brain activate/compile returned plan-only exit 2; no policy adapters were rewritten. Mission attach-task reported its existing lock busy, so a separate scoped task was created and claimed without changing mission state.

Review gate: the plain node command selected the previously recorded alternate runtime and exited 1 (70 passed, 25 failed); receipt atris/runs/2026-10-15-task-bci-14-2026-10-15T02-53-03-266Z.json. The direct frozen command above passed under Node v25.6.1. Readiness passed with /opt/homebrew/bin/node explicitly, exit 0, receipt atris/runs/2026-10-15-task-bci-14-2026-10-15T02-53-47-339Z.json. Work is in Review; automatic certification cannot rerun absolute-path commands, so independent review remains.

next_push: Prove the idle board switches to a current member and back when progress arrives in a narrow terminal.
layer: behaviors

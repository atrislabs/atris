# Small-screen idle transitions

Added a real terminal regression for idle, working, finished, and idle again. Three layouts passed and all 96 required tests passed, exit 0. Existing runtime behavior needed no change.

Plan: idle -> partial start stays idle -> newline shows working -> finished ok -> old log restores idle.

Files: test/member-board.test.js; atris/receipts/member-board-idle-transition-proof.py; atris/receipts/member-board-idle-transition-output.txt; atris/receipts/member-board-idle-transition-receipt.md; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md (new entry only).

Real command: python3 atris/receipts/member-board-idle-transition-proof.py
Exit: 0

```text
command: node bin/atris.js member board --watch (18x3)
idle: idle. 1 older
partial start: still idle
working: 'member   state\nbuilder  working'
finished: 'member   state\nbuilder  ok'
idle again: idle. 1 older
exit: 0
command: node bin/atris.js member board --watch (30x3)
idle: idle. 1 older runs hidden
partial start: still idle
working: 'member   state    last result\nbuilder  working  ok'
finished: 'member   state  last result\nbuilder  ok     ok'
idle again: idle. 1 older runs hidden
exit: 0
command: node bin/atris.js member board --watch (47x2)
idle: nobody is working. 1 older runs hidden
partial start: still idle
working: 'member   state    last result\nbuilder  working  ok'
finished: 'member   state    ago     job\nbuilder  done ok  0s ago  keep the board rea...'
idle again: nobody is working. 1 older runs hidden
exit: 0
three small layouts keep complete states within the screen through live transitions
```

Required check: node --test test/member-board.test.js test/member-result.test.js
Runtime: Node v25.6.1
Exit: 0

```text
✔ an unknown member is an error, printed as json with exit 1 (0.706875ms)
ℹ tests 96
ℹ suites 0
ℹ pass 96
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37700.305125
```

Other checks: git diff --check (exit 0); atris slop detect atris/receipts/member-board-idle-transition-proof.py test/member-board.test.js (exit 0, clean).

Readiness: `/opt/homebrew/bin/node --test test/member-board.test.js test/member-result.test.js` also exited 0 through the task gate. Task is in Review; the absolute path requires independent review. Executed receipt: `atris/runs/2026-10-15-task-bci-15-2026-10-15T02-57-40-960Z.json`.

Progress: one new real-command regression; three small terminal layouts; 96 passed, 0 failed, 0 skipped. No dependency changes.

Learning: an idle member's old result may remain beside its new working state. This check waits for a new finished frame without working text, so an old ok cannot pass as a new finish. The return to idle uses an old log rather than waiting an hour.

Navigation compilation was invoked in plan mode, leaving generated policy files unchanged. Mission attachment reported the existing runner's lock busy; its state was preserved and a dedicated task records this increment.

next_push: Check a failed result written in parts during idle-to-working transitions on a small terminal.
layer: behaviors

The compact board keeps common failure reasons visible from 30 to 42 columns; four real terminal invocations and all 42 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md. The task CLI regenerated atris/TODO.md.
Artifacts produced: atris/runs/member-board-compact-columns-proof.py, atris/runs/member-board-compact-columns-receipt.md.
Plan: overflowing columns -> compact member/state/result view -> actual terminal -> required tests -> review and push.

Verification command: node --test test/member-board.test.js test/member-result.test.js
Exact output excerpt:
ℹ tests 42
ℹ pass 42
ℹ fail 0
Exit: 0

Real surface command: python3 atris/runs/member-board-compact-columns-proof.py
Runs node bin/atris.js member board in a real pseudo-terminal at 30, 32, 38 and 42 columns, with isolated temporary member logs.
Exact output excerpt at 30 columns:
member   state    last result
breaker  failed   bad exit 2
builder  failed   timed out
chat...  failed   engine error
scout    working  -
exit: 0
All four terminal runs exited 0, every line fit, and every common failure reason remained whole.

Other commands: atris brain activate --root . --verify (plan only, exit 2); atris; atris mission status mission-2026-10-14-continue-improving-atris-mem-187401de; atris mission goal --json (no candidate); atris task list; atris task new; atris task claim BCI-9 --as builder; atris task note BCI-9; git status --short; git diff --check (exit 0); git diff; atris brain compile --root . (plan only, exit 2).

Progress: one compact layout fallback, one regression, four terminal widths, zero failing tests. Long names shorten; the job, age and live engine columns leave only when the normal view would wrap. Windows below 30 columns remain a next step.
Learning: after job and step reach their minimum widths, dropping low-priority columns preserves whole failure reasons better than clipping a complete row.
next_push: Keep essential member states readable below 30 columns.
layer: behaviors

Review handoff: the task command selected unsupported Node 20 in its login shell, so its rerun failed (26 passed, 3 failed, 13 cancelled). Repeating the required tests with /opt/homebrew/Cellar/node/25.6.1/bin/node passed all 42, exit 0. The task is in Review; the absolute command needs independent review. No mission settings changed.

Tiny board footers preserve failure counts; the real terminal watch command and all 39 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts produced: atris/runs/member-board-tiny-footer-proof.py, atris/runs/member-board-tiny-footer-receipt.md.
Commands run: atris mission status mission-2026-10-14-continue-improving-atris-mem-187401de; git status --short; atris; atris brain activate --root . --verify; atris mission goal --json; atris task list --status open; atris task list --status doing; atris task new; atris task claim BCI-4 --as builder; atris task note BCI-4; git remote -v; git log -3 --oneline.

Plan: existing footer -> shorter hidden prefix -> cut only if unavoidable.
Change: use "hidden" after the longer footer forms fail to fit. Existing wording and reason retention order stay intact.
Real surface proof: python3 atris/runs/member-board-tiny-footer-proof.py
Actual command: node bin/atris.js member board --watch, 30 columns and 7 rows, isolated progress logs.
Output excerpt:
member  state        last result  ago     job
f1      done failed  timed out    1m ago  job

3 hidden (2 failed, 1 stopped)

redraws every 3s, ctrl-c to stop
exit: 0

Rerunnable verifier: node --test test/member-board.test.js test/member-result.test.js
Exact final output:
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5654.388125
exit: 0

Progress: failure and stopped counts fit at 30 columns rather than 38, eight columns saved. Regression also covers earlier failures and unavoidable truncation below the fitting boundary. First terminal proof used 29 columns, below the 30-character footer length, and correctly truncated; the corrected 30-column proof passed. Board rows still exceed extremely narrow widths, which remains a separate bounded improvement.
next_push: remove duplicate age information from finished rows below 50 columns to keep the failure reason visible without wrapping.
layer: behaviors

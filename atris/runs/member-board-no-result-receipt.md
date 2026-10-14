Missing results now keep their full wording beside finishing members from 33 columns; five actual terminal commands and all 45 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-no-result-proof.py and atris/runs/member-board-no-result-receipt.md. Existing changes in atris/TODO.md excluded from staging.
Plan: missing wording -> preserve when it fits -> actual terminal -> required tests -> review -> commit and push.
Rerun: node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 45; suites 0; pass 45; fail 0; cancelled 0; skipped 0; todo 0. Exit: 0. Runtime: Node v25.6.1.
Actual surface: python3 atris/runs/member-board-no-result-proof.py
Command invoked: node bin/atris.js member board, actual terminals at 30, 32, 33, 34 and 38 columns, 12 rows. All five exits: 0. Every line fits.
33-column output:
name  state      last result
s...  finishing  -
c...  stopped    ended, no result
exit: 0
30-column output:
member  state      last result
scout   finishing  -
cha...  stopped    no result
exit: 0

Commands: atris mission status mission-2026-10-14-continue-improving-atris-mem-187401de; git status --short; atris task list --status open; atris brain activate --root . --verify (plan only); atris mission goal --json (no candidate); atris mission attach-task 29 --json (parent holds lock, left untouched); atris; atris task new; atris task claim BCI-12 --as builder; atris task note BCI-12; python3 atris/runs/member-board-no-result-proof.py; node --test test/member-board.test.js test/member-result.test.js; git diff --check; atris task ready; atris brain compile --root .; git add; git commit; git push.
Initial terminal assertion used an incorrect 32-column boundary; corrected to 33. Initial test helper omitted its startup script; terminated only that test run and corrected the helper before the passing invocation.
Progress: one layout improvement; one real-process regression covering five widths; five actual CLI exits 0; 45 tests pass, zero failures.
Learning: preserve the distinction between a stopped run and an ended run with no recorded result whenever the terminal has room.
next_push: Keep hidden ended-with-no-result counts whole in short narrow board footers.
layer: behaviors

Review handoff: task ready reran the required suite with Node 25, exit 0. Proof is in Review; the absolute runtime requires independent review. Brain compile remained plan only, exit 2. No acceptance was performed.

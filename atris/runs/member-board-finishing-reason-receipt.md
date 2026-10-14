Failure reasons now stay whole beside finishing members at 30 columns; all 44 required tests and four actual terminal commands passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-finishing-reason-proof.py and atris/runs/member-board-finishing-reason-receipt.md. The already changed rendered atris/TODO.md is excluded from staging.
Plan: compact member heading -> name when necessary -> whole reasons -> real terminal -> required tests -> review and push.
Rerun: node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 44; suites 0; pass 44; fail 0; cancelled 0; skipped 0; todo 0.
Exit: 0. Runtime: Node v25.6.1.

Real surface: python3 atris/runs/member-board-finishing-reason-proof.py
Invokes node bin/atris.js member board in actual pseudo-terminals at 30, 31, 32 and 38 columns, 12 rows. Each invocation exited 0 and every output line fit.
Exact 30-column output:
name   state      last result
br...  failed     bad exit 2
ch...  failed     engine error
scout  finishing  -
bu...  failed     timed out
exit: 0

Commands: atris brain activate --root . --verify (plan only, exit 2); atris mission status mission-2026-10-14-continue-improving-atris-mem-187401de; git status --short; atris task list --status open; atris; atris mission goal --json (no candidate); atris task new; atris task claim BCI-11 --as builder; atris task note BCI-11; python3 atris/runs/member-board-finishing-reason-proof.py; node --test test/member-board.test.js test/member-result.test.js; git diff --check; atris task ready; atris brain compile --root .; git add; git commit; git push.
Progress: one compact layout edge fixed, one regression covering four widths, four real CLI checks, zero required test failures. A 30-column mixed view spends two fewer columns on the member heading and trims long names to retain complete reasons.
Learning: reserve space using the actual heading width rather than a fixed member width, so finishing and engine error can coexist.
next_push: Preserve ended-with-no-result wording in compact rows alongside finishing members.
layer: behaviors

Review handoff: required tests passed again through task ready with the supported Node 25 executable, exit 0. Proof is in Review; absolute runtime requires independent review. Brain compile remained plan only, exit 2. No acceptance was performed.

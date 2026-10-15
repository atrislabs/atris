Member states now fit from 18 to 29 columns; four actual terminal runs and all 43 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md. Task commands regenerated atris/TODO.md, which already had changes at entry and is excluded from staging.
Artifacts: atris/runs/member-board-smallest-columns-proof.py and atris/runs/member-board-smallest-columns-receipt.md.
Plan: overflowing board -> member/state view -> real terminal -> required tests -> review and push.

Rerun: node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 43; pass 43; fail 0; cancelled 0; skipped 0; todo 0.
Exit: 0.
An initial run failed one new assertion that assumed a whole engine error reason would fit alongside finishing at 30 columns. The corrected assertion checks the returning result column; the required suite then passed. Existing reason clipping in that mixed view is next work, not part of this slice.

Real surface: python3 atris/runs/member-board-smallest-columns-proof.py
Invokes node bin/atris.js member board in real pseudo-terminals at 18, 20, 24 and 29 columns, 12 rows, with temporary project/member logs.
Exact 18-column output:
member     state
breaker    failed
builder    failed
chat-e...  failed
scout      working
exit: 0
All four invocations exited 0 and every line fit the requested width.

Other commands: git status --short; atris mission status mission-2026-10-14-continue-improving-atris-mem-187401de; atris mission goal --json (no candidate); atris task list; atris task new; atris task claim BCI-10 --as builder; atris task note BCI-10; atris brain activate --root . --verify (plan only, exit 2); git diff --check; atris task ready; git add; git commit; git push.
Progress: one smaller layout, one regression covering seven states at four widths, four real CLI invocations, zero failing required tests. Below 30 columns the result column leaves to keep whole state words; full output and JSON keep their existing fields. Below 18 columns remains unsupported by this fallback.
Learning: a two-column view preserves whole states even when finishing is longer than working. Mixed states can still shorten an engine error reason at 30 columns in the three-column view.
next_push: Preserve engine error at 30 columns when another member is finishing before sleep.
layer: behaviors

Review handoff: task ready reran the required suite with the explicit supported Node 25 executable, exit 0. The task is in Review and requires independent review of the absolute command. Receipt: atris/runs/2026-10-14-task-bci-10-2026-10-14T20-36-34-375Z.json. Brain compile was plan only, exit 2; unrelated generated policy files were not written.

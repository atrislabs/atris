Live follow now has real-command coverage for shortening a log during an unfinished result. Required checks: 73 passed, zero failures, exit 0.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts produced: atris/runs/member-board-live-shrink-proof.txt, atris/runs/member-board-live-shrink-receipt.md.
Verify: node --test test/member-board.test.js test/member-result.test.js
Proof run: ATRIS_BOARD_SHRINK_PROOF=atris/runs/member-board-live-shrink-proof.txt node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 73; suites 0; pass 73; fail 0; cancelled 0; skipped 0; todo 0; exit 0.
Real surface: node bin/atris.js member board --json --follow, spawned by the regression. Output excerpt:
{"member":"navigator","mission":"m-new","at":"2026-10-15T00:55:17.700Z","kind":"started","text":"next job"}
{"member":"navigator","mission":"m-new","at":"2026-10-15T00:55:17.700Z","kind":"step","text":"reading fresh notes"}
{"member":"navigator","mission":"m-new","at":"2026-10-15T00:55:17.700Z","kind":"finished","text":"ok","ok":true}
Actual command exit: 0 after interrupt.
Progress: one additional runtime regression, 72 to 73 passing checks. No production change or new dependencies.
Plan: opening snapshot -> unfinished old result -> shorter log with new start and partial step -> completed step -> next result -> interrupt.
Commands also run: atris; atris mission status; atris mission goal --json; atris task list/new/claim/note/ready; git status; git diff --check; git add; git commit; git push; atris brain activate --root . --verify; atris brain compile --root .; atris slop detect.
Brain commands are plan-only exit 2, so no generated policy was written. No mission settings changed. Existing unrelated edits to atris/TODO.md and test/member-board-last-result.test.js remain unstaged. Readiness reruns the required check with the supported Node runtime, as earlier receipts document the login-shell runtime mismatch.
Readiness: exit 0, proof moved to Review; saved receipt atris/runs/2026-10-15-task-bci-6-2026-10-15T00-56-11-500Z.json. Automatic acceptance cannot rerun the supported-runtime prefix; no acceptance claimed.
Learned: make the replacement shorter than the consumed opening line to prove actual shrink recovery. New partial text waits through polling, and the old unfinished timeout never emits.
next_push: Prove live follow resumes after a progress log disappears and is recreated with split output.
layer: behaviors

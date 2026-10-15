Live terminal resize now has a real-command regression. Required checks: 72 passed, 0 failed, exit 0.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md. Task commands also update the rendered atris/TODO.md; its pre-existing edit is left unstaged. Unrelated test/member-board-last-result.test.js is untouched.
Artifacts: atris/runs/member-board-live-resize-receipt.md, atris/runs/member-board-live-resize-proof.txt.
Verify: node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 72; suites 0; pass 72; fail 0; cancelled 0; skipped 0; todo 0; exit 0.
Focused proof: node --test --test-name-pattern="the real terminal keeps timeout reasons" test/member-board.test.js
Exact output: tests 1; pass 1; fail 0; exit 0.
Actual surface: node bin/atris.js member board --watch, launched in a real pseudo-terminal by the focused test. Four frames: 80 columns/8 rows -> 47/2 -> 30/3 -> 80/8. Full stdout is saved in member-board-live-resize-proof.txt. Exit 0 after SIGINT.
Output excerpts:
47x2: 3 more not shown (3 failed, all timed out)
30x3: builder  failed  timed out
30x3: 2 hidden (2 failed, timed out)
Restored: all three member rows and redraw hint return.
Progress: one real CLI regression added, four live terminal sizes checked, all rows/columns bounded, timeout reason retained, resizes faster than 2.5s, clean exit. Runtime already works, so no production change was needed. Uses Python standard-library terminal APIs on Unix, skips Windows.
Commands also run: atris brain activate --root . --verify; atris; git status --short; atris mission status mission-2026-10-14-continue-improving-atris-mem-52869ba8; atris mission goal --json; atris task list/new/claim/note/ready; atris brain compile --root .; git diff --check; git add; git commit; git push. Brain commands returned plan-only exit 2; unrelated generated policy was not written. No mission policy changed and no task acceptance claimed.
Learned: direct renderer tests cannot prove delivery of real terminal resize signals; a pseudo-terminal covers resize, frame dimensions, restoring content, and interrupt together.
next_push: Prove live terminal redraw shows a newly completed split timeout without losing the short-screen footer.
layer: behaviors

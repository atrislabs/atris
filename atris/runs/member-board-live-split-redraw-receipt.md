Split timeout completion now has short-screen live redraw coverage. Required checks: 72 passed, 0 failed, exit 0.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-live-split-redraw-receipt.md, atris/runs/member-board-live-split-redraw-proof.txt.
Verify: node --test test/member-board.test.js test/member-result.test.js
Run: ATRIS_BOARD_TERMINAL_PROOF=atris/runs/member-board-live-split-redraw-proof.txt node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 72; suites 0; pass 72; fail 0; cancelled 0; skipped 0; todo 0; exit 0.
Actual command: node bin/atris.js member board --watch, launched by the test in a real pseudo-terminal. Exit 0 after SIGINT.
Output before and during incomplete timeout: 3 hidden (2 failed, timed out, scout working)
Output after completed timeout: 3 more not shown (3 failed, all timed out)
Progress: existing real-terminal regression extended with two scheduled redraws at 47 columns and 2 rows; all six frames fit, incomplete finish stays working, completed finish updates failure count and reason. No production change or dependencies needed. Unix terminal check skips Windows.
Initial verification failed because the new Python setup missed a string concatenation operator. Corrected; complete rerun passed.
Commands also run: atris mission status; atris mission goal --json; atris task list/new/claim/note/ready; atris; atris brain activate --root . --verify; atris brain compile --root .; git status --short; git diff --check; git add; git commit; git push.
Brain commands are plan-only exit 2, with no generated policy written. Unrelated atris/TODO.md and test/member-board-last-result.test.js edits stay unstaged. No mission settings changed and no acceptance claimed. Ready requires its own execution, so the same required checks ran again through ready with PATH=/opt/homebrew/bin:$PATH to avoid the known login-shell Node 20 selection. Ready exited 0 and moved proof to Review; automatic certification cannot rerun that runtime prefix. Readiness artifact: atris/runs/2026-10-15-task-bci-5-2026-10-15T00-53-40-773Z.json.
Learned: a resize-only proof does not cover periodic redraw reading a file while its finished line is half written. Waiting for the real scheduled redraw proves that path without forcing a signal.
next_push: Prove live follow handles a split progress line during real log truncation and resumes without duplicate events.
layer: behaviors

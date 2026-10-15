Live progress now recovers after a missing log returns, verified by 74 passing checks and a real follow command exiting 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-live-return-proof.txt, atris/runs/member-board-live-return-receipt.md.
Verify: node --test test/member-board.test.js test/member-result.test.js
Proof invocation: ATRIS_BOARD_RETURN_PROOF=atris/runs/member-board-live-return-proof.txt node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 74; suites 0; pass 74; fail 0; cancelled 0; skipped 0; todo 0; exit 0.
Real command: node bin/atris.js member board --json --follow, spawned with an isolated temporary progress directory by the regression. Exit 0 after interrupt.
Output excerpt: {"member":"navigator","mission":"m-new","kind":"step","text":"reading fresh notes"}; final event {"kind":"finished","text":"ok","ok":true}. Full records, timestamps, and command are in the proof file.
Plan: snapshot -> unfinished old timeout -> log absent across polling -> larger replacement start and split step -> completed step -> successful result -> interrupt.
Before fix: the real-command regression exited 1 because the replacement start was skipped. After clearing absent logs from the offset map, the first full run exposed a trailing-space mistake in the fixture; the corrected fixture and full suite passed.
Progress: fixed one runtime bug; required checks increased from 73 to 74. No dependencies added. Recovery requires a scan to observe the log absent; replacement entirely between scans remains a separate case.
Readiness first reran in a different login-shell Node runtime and failed 11 checks, matching the runtime mismatch recorded in prior receipts. The frozen direct invocation above used Node 25.6.1 and passed. Retrying readiness with the same supported runtime explicitly selected in its command; mission verifier unchanged.
Other commands: atris; atris mission status; atris mission goal --json; atris task list/new/claim/note/ready; atris brain activate --root . --verify; atris brain compile --root .; atris slop detect lib/member-board.js test/member-board.test.js; git diff --check; git add; git commit; git push.
Slop check: clean, no slop tells in 2 files, exit 0. Whitespace check: exit 0.
Brain commands printed a plan only; generated policy was not changed. Several compiled-brain inputs are absent in this checkout. No mission settings or unrelated edits were changed. Existing atris/TODO.md and test/member-board-last-result.test.js edits remain unstaged.
Learned: a missing log retains an obsolete byte offset unless explicitly forgotten. Recreate a larger file in regression coverage so shrink detection cannot conceal the bug.

Readiness passed with supported runtime, exit 0; receipt atris/runs/2026-10-15-task-bci-7-2026-10-15T00-59-48-829Z.json. Proof is in Review. Automatic certification cannot rerun the runtime prefix, so acceptance remains pending. This change is committed and pushed with unrelated edits left unstaged.
next_push: Prove live follow detects a same-size replacement made between scans.
layer: behaviors

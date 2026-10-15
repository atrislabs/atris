Live progress now recovers after an atomic same-size log replacement, verified by 75 passing checks and the real follow command exiting 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-live-replace-proof.txt, atris/runs/member-board-live-replace-receipt.md.
Verify: node --test test/member-board.test.js test/member-result.test.js
Proof invocation: ATRIS_BOARD_REPLACE_PROOF=atris/runs/member-board-live-replace-proof.txt node --test test/member-board.test.js test/member-result.test.js
Exact output: tests 75; suites 0; pass 75; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 34792.645916; exit 0.
Real command: /opt/homebrew/Cellar/node/25.6.1/bin/node bin/atris.js member board --json --follow, spawned in an isolated temporary progress directory by the regression. Exit 0 after interrupt. Full absolute command and unmodified output are in the proof file.
Output excerpt: {"member":"navigator","mission":"m-new","kind":"started","text":"next job"}; {"member":"navigator","mission":"m-new","kind":"finished","text":"ok","ok":true}. The split step preserves padding spaces used to make the replacement exactly the old file size.
Plan: snapshot -> unfinished old timeout -> atomic equal-size replacement -> complete new start -> split new step -> complete step -> successful result -> interrupt.
Before fix: node --test --test-name-pattern='atomic same-size' test/member-board.test.js exited 1, expected replacement start but only snapshot arrived. After fix: same command exited 0, pass 1, fail 0. Then the full frozen suite passed once with real command output saved.
Change: compare device and inode on the opened file, keeping its offset with that identity. Replacement starts at byte zero even when the path never disappears and size stays equal. Normal append and partial-line handling remain covered by the full suite.
Progress: one runtime bug fixed, required checks increased from 74 to 75. No dependencies added. Does not detect same-inode rewrites that refill past the old cursor between scans; that is the next bounded case.
Other commands: atris brain activate --root . --verify; atris; git status --short --branch; atris mission status mission-2026-10-14-continue-improving-atris-mem-52869ba8; atris mission goal --json; atris task list --status open; atris task new/claim/note/ready; atris brain compile --root .; atris slop detect lib/member-board.js test/member-board.test.js; git diff --check; git diff; git add; git commit; git push.
Slop check: clean, no slop tells in 2 files, exit 0. Whitespace check: exit 0.
Brain activation and compile returned plan-only exit 2. Generated policy was not changed. Several compiled inputs and SOUL.md are absent. Existing workspace preserved. Prior work already carried forward in the current branch history. Unrelated edits to atris/TODO.md and test/member-board-last-result.test.js remain unstaged.
Learned: size and disappearance cannot identify atomic replacement. File identity must come from the same open descriptor as the bytes being read.
Readiness uses the saved proof rather than another verification run, honoring the instruction to stop after this slice passes. Human acceptance remains separate.
next_push: Prove recovery when the same inode is truncated and refilled past the old cursor between scans.
layer: behaviors

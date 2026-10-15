New live logs now have a real-command regression for split Windows-style line endings, verified by 76 passing checks and command exit 0.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-new-log-crlf-proof.txt, atris/runs/member-board-new-log-crlf-receipt.md.
Verify: node --test test/member-board.test.js test/member-result.test.js
Invocation: node --test test/member-board.test.js test/member-result.test.js > atris/runs/member-board-new-log-crlf-proof.txt 2>&1
Exact output: tests 76; suites 0; pass 76; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 38589.907584; exit 0.
Real command: /opt/homebrew/Cellar/node/25.6.1/bin/node bin/atris.js member board --json --follow. The regression launches this CLI in a temporary progress folder and records its actual command, stdout, and clean interrupt exit in the proof file.
Output excerpt:
{"member":"scout","mission":"m-new","at":"2026-10-15T01:05:06.250Z","kind":"started","text":"inspect new progress"}
{"member":"scout","mission":"m-new","at":"2026-10-15T01:05:06.250Z","kind":"step","text":"reading notes"}
{"member":"scout","mission":"m-new","at":"2026-10-15T01:05:06.250Z","kind":"finished","text":"ok","ok":true}
Plan: empty snapshot -> create start ending CR -> wait across polling -> append LF, full step, partial result -> wait -> append LF -> wait -> interrupt.
Progress: one real-runtime regression added, required suite increases from 75 to 76 passing checks. Each of three new events arrives exactly once; unfinished starts and results emit nothing. No runtime change or dependency needed.
Learned: new-log discovery and split CRLF buffering already compose correctly, including a complete batch followed by a partial result. This proves that behavior and protects it from regression.
Other commands: atris; git status --short/-sb; atris mission status; atris mission goal --json; atris task list/new/claim/note/ready; atris brain activate --root . --verify; atris brain compile --root .; atris slop detect test/member-board.test.js; git diff --check; git diff; git add; git commit; git push.
Slop check: clean, no slop tells in 1 file, exit 0. Whitespace check: exit 0.
Mission task attachment reported a busy lock held by the running mission; it was left intact. A separate bounded task records this proof. Brain commands were plan-only; generated policy was not changed. Existing edits to atris/TODO.md and test/member-board-last-result.test.js were preserved and left unstaged.
Readiness uses saved proof without repeating the passed verification. Human acceptance remains separate.
next_push: Prove recovery when the same inode is truncated and refilled past the old cursor between scans.
layer: behaviors

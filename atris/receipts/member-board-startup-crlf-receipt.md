# Split line endings at startup

The live follow check now covers a first start line ending with CR before startup as well as a log created afterward. The real command keeps the partial line out of the opening snapshot, releases completed start and step events once, waits for the result newline, and exits cleanly on interrupt.

Files: `test/member-board.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/builder/logs/2026-10-14.md`, and this receipt. The generated `atris/TODO.md` remains unstaged because it already had changes before this work.

Plan: partial CR -> opening snapshot -> LF -> exact events -> clean interrupt.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. Output captured in `/tmp/member-board-tick55-test.txt`.

Real CLI invocation (run by both regression cases): `node bin/atris.js member board --json --follow`, using an isolated temporary progress folder and a 100ms polling interval. Exact command paths and stdout follow.

```text
✔ live follow waits for split CRLF lines after startup (1420.534667ms)
ℹ actual command: /opt/homebrew/Cellar/node/25.6.1/bin/node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/builder-continue-improving-atris-member-boar-20261015-003022/bin/atris.js member board --json --follow
ℹ actual stdout:
{"kind":"snapshot","at":"2026-10-15T05:44:06.757Z","dir":"/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-board-5KSSPZ","members":[]}
{"member":"scout","mission":"m-new","at":"2026-10-15T05:44:06.671Z","kind":"started","text":"inspect new progress"}
{"member":"scout","mission":"m-new","at":"2026-10-15T05:44:06.671Z","kind":"step","text":"reading notes"}
{"member":"scout","mission":"m-new","at":"2026-10-15T05:44:06.671Z","kind":"finished","text":"ok","ok":true}
exit: 0
✔ live follow waits for split CRLF lines before startup (1464.836625ms)
ℹ actual command: /opt/homebrew/Cellar/node/25.6.1/bin/node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/builder-continue-improving-atris-member-boar-20261015-003022/bin/atris.js member board --json --follow
ℹ actual stdout:
{"kind":"snapshot","at":"2026-10-15T05:44:08.200Z","dir":"/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-board-J1P0Hg","members":[]}
{"member":"scout","mission":"m-new","at":"2026-10-15T05:44:08.094Z","kind":"started","text":"inspect new progress"}
{"member":"scout","mission":"m-new","at":"2026-10-15T05:44:08.094Z","kind":"step","text":"reading notes"}
{"member":"scout","mission":"m-new","at":"2026-10-15T05:44:08.094Z","kind":"finished","text":"ok","ok":true}
exit: 0
ℹ tests 107
ℹ suites 0
ℹ pass 107
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 51783.891375
```

Progress: one additional real startup case, 107 passing checks, zero failures or skipped checks. No runtime or dependency changes.

Learned: the same CRLF test can cover an existing unfinished log and a newly created log without a second copy of the harness.

Review recording: the proof-only request was rejected because it had not run the command in that process. The required review invocation then exited 0:

`atris task ready BCI-20 --verify 'PATH=/opt/homebrew/bin:$PATH node --test test/member-board.test.js test/member-result.test.js' --proof 'Real CLI output and direct required-check exit 0 are saved in atris/receipts/member-board-startup-crlf-receipt.md.' --result 'Operators can trust live progress to wait for a complete first line even when the log exists before startup.'`

The local supported-runtime prefix avoids the known login-shell Node 20 mismatch. The task is in Review; automatic certification cannot rerun this prefixed command. No task acceptance was performed. Review receipt: `atris/runs/2026-10-15-task-bci-20-2026-10-15T05-46-03-187Z.json`.

next_push: prove a CRLF result split across startup after an already completed start line.
layer: behaviors

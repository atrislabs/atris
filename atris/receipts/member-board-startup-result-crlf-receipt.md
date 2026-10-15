# Completed Windows-style lines remain visible at startup

Startup now reads completed Windows-style lines while keeping an unfinished result pending. The real follow command showed the member working, emitted its timeout once after LF, delivered the next start and step intact, and exited 0 on interrupt.

Plan: completed start + CR-ended result -> working snapshot -> LF -> one result -> next run -> clean interrupt.

Files edited: lib/member-board.js; test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt. Existing generated atris/TODO.md changes were left unstaged.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit code: 0. Full output: `/tmp/member-board-tick56-test.txt`.

The first run reproduced the defect: 107 passed, 1 failed, exit 1. A completed CRLF start was absent from the snapshot because the parser's regular expression could not match the trailing CR. Removing one trailing CR before parsing aligns startup with the existing live event reader. No dependencies or command changes.

Real CLI command and stdout, captured by the regression:

```text
✔ atris member board --json --follow streams full events with timeout CRLF split before startup (1008.251917ms)
ℹ actual command: /opt/homebrew/Cellar/node/25.6.1/bin/node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/builder-continue-improving-atris-member-boar-20261015-003022/bin/atris.js member board --json --follow
ℹ actual stdout:
{"kind":"snapshot","at":"2026-10-15T05:49:17.082Z","dir":"/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-board-4Piu8T","members":[{"member":"navigator","state":"working","last_result":"","last_result_reason":"","last_result_ran":"","last_result_engine":"","last_result_ago":"","no_result":false,"pid":null,"engine":"","alive":null,"running_for":"","job":"map the repo","step":"","ago":"5s ago","at":1792043351983,"idle":false,"asleep":false}]}
{"member":"navigator","mission":"m-9","at":"2026-10-15T05:49:16.984Z","kind":"finished","text":"failed (timed out)","ok":false}
{"member":"navigator","mission":"m-11","at":"2026-10-15T05:49:17.937Z","kind":"started","text":"verify another job"}
{"member":"navigator","mission":"m-11","at":"2026-10-15T05:49:17.937Z","kind":"step","text":"reading atris/MAP.md"}
{"member":"scout","mission":"m-10","at":"2026-10-15T05:49:17.937Z","kind":"finished","text":"failed","ok":false}
exit: 0
ℹ tests 108
ℹ suites 0
ℹ pass 108
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52610.010666
```

Progress: one additional live startup case; 108 passed, 0 failed, 0 skipped. The existing two split-timeout cases now also assert clean interrupt and save their command output.

Learned: split-line follow checks alone did not prove the startup snapshot could read complete CRLF lines; both parsing paths need the same line-ending handling.

next_push: prove completed CRLF signed-out results retain their engine and sign-in guidance in the opening board.
layer: behaviors

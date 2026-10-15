# Bound live follow cleanup

Live follow checks now kill a stuck child after 30 seconds, verified by the required suite and a real suspended follower.

Changed files: `test/member-board.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/receipts/member-board-follow-deadline-proof.cjs`, this receipt, and `atris/team/builder/logs/2026-10-14.md`.

The ten asynchronous follow launch sites previously bounded output waits but awaited child close indefinitely in cleanup. Each now has a 30-second SIGKILL deadline. Normal ctrl-c exit checks remain unchanged, so hitting the deadline fails the existing expectations instead of passing silently. This bounds each child, not the duration of the whole suite.

Required verification: `node --test test/member-board.test.js test/member-result.test.js`
Exit: 0

```text
✔ an unknown member is an error, printed as json with exit 1 (1.040125ms)
ℹ tests 106
ℹ suites 0
ℹ pass 106
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 50735.541125
```

Real command proof: `node atris/receipts/member-board-follow-deadline-proof.cjs`
Exit: 0. The proof reads the actual configured limit from the test file, starts the real CLI, waits for its snapshot, suspends it, sends ctrl-c, and observes the hard deadline close it.

```text
command: node bin/atris.js member board --json --follow
child lifetime: 30000ms; final signal: SIGKILL
snapshot received; suspend the child so it cannot handle ctrl-c
child closed: code=null, signal=SIGKILL, elapsed=30004ms
proof exit: 0

```

The original suite also passed with exit 0 in 106245.542209ms, so the earlier 685-second timeout was not reproduced. The updated suite passed in 50735.541125ms; those runs overlapped briefly and do not establish a speed improvement. This change addresses an identified unbounded cleanup path, not a proven cause of the earlier timeout.

Inspected existing mission and task state, member identity, navigation, and git status before editing. Brain activation and compilation returned plan-only output; generated adapters were preserved. The pre-existing rendered TODO change is excluded from staging. No mission settings or runtime behavior changed.

next_push: Bound the blocking JSON reads in the real wide-name follow proof so stalled startup reports its cause promptly.

layer: behaviors

# Watch shutdown proof

The watch screen now has a regression check for stopping every redraw source. No product behavior changed.

Files: `test/member-board.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/receipts/member-board-watch-stop-proof.py`, this receipt, and `atris/team/builder/logs/2026-10-14.md`.

The inherited unfinished test was completed with a resize event after interrupt. The test uses a controlled clock to exercise the pending log redraw and two subsequent periodic deadlines, and checks the folder watch is closed.

## Proof

`node --test test/member-board.test.js test/member-result.test.js`

```text
ℹ tests 90
ℹ pass 90
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 27312.911209
exit: 0
```

`python3 atris/receipts/member-board-watch-stop-proof.py`

```text
command: node bin/atris.js member board --watch (40 columns, 3 rows)
member   state    ago     job
builder  working  0s ago  check board
exit: 0
one frame; clean interrupt with a log change queued
```

The first terminal probe waited for a job phrase that was clipped at 40 columns. It failed, then the fixture job was shortened to fit. No product fix was needed.

Fault checks ran in temporary copies, leaving product files untouched. For each copy the command was `node --test --test-name-pattern='ctrl-c stops every watch redraw' <temporary-copy>/test/member-board.test.js`. Removing each cleanup statement separately produced exit 1:

```text
pending redraw: caught, exit 1
periodic redraw: caught, exit 1
folder watch: caught, exit 1
resize listener: caught, exit 1
```

Progress: 89 to 90 passing tests, four independently detected shutdown faults. The real CLI proof confirms clean exit, while resource cleanup itself is checked in process.

Other commands: mission status, brain activate (preview only), mission goal, task list/new/claim/note/ready, git status/diff/log, slop detect, brain compile (preview only), and git commit/push. Existing rendered task changes and earlier log entries were preserved.

next_push: Prove the watch screen recovers when its progress folder is missing at startup and appears before the next timed redraw.

layer: behaviors

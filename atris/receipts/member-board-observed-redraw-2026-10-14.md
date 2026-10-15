# Observe the scheduled board redraw

Split-failure checks now wait for another actual frame instead of sleeping 3.2 seconds. This proves the scheduled redraw occurred while the result was incomplete.

Changed: `atris/receipts/member-board-idle-transition-proof.py`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/builder/logs/2026-10-14.md`.

Verification command: `node --test test/member-board.test.js test/member-result.test.js`
Exit: 0

The suite invoked the real watch command in ten independent terminals. Seven split-failure cases observed a redraw without another log write; every frame stayed within its screen, completion waited for newline, and all ten commands exited 0. No speed claim is made because no controlled before/after measurement ran.

Actual command output excerpt:

```text
command: node bin/atris.js member board --watch (60x3)
idle: nobody is working. 1 older runs hidden. --all shows them
partial start: still idle
working: 'member   state    last result  run        ago     job\nbuilder  working  ok 9784d     claude 0s  0s ago  keep th...'
partial failure: still working through observed periodic redraw
complete text without newline: still working
finished: 'member   state        last result  ago     job\nbuilder  done failed  signed out   3s ago  sign in to claude'
idle again: nobody is working. 1 older runs hidden. --all shows them
exit: 0
```

Required check output:

```text
ℹ tests 106
ℹ suites 0
ℹ pass 106
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 123423.143334
```

Setup inspected mission status, task state, git status, member identity, and navigation. Mission attachment was unavailable because another process holds its lock; a separate claimed task records this bounded change. Brain activation and compilation were invoked and returned plan-only output, so generated policy adapters were preserved. The pre-existing rendered TODO change is excluded from the commit.

next_push: Replace the fixed wait in the real progress-folder check with a bounded wait for complete output.

layer: behaviors

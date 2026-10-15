Shared failure reasons now survive in narrower board footers; the real watch command and all 39 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-tiny-reason-proof.py, atris/runs/member-board-tiny-reason-receipt.md.
Change: try the hidden prefix with a shared reason before dropping that reason. Current and earlier failures cover timed out, engine error, and bad exit 2 at the exact fitting boundary and one column below.
Plan: shared reason -> shorter prefix -> reasonless counts -> cut only if unavoidable.
Real surface command: python3 atris/runs/member-board-tiny-reason-proof.py
Invoked: node bin/atris.js member board --watch in a 42-column, 7-row terminal with isolated logs.
Output excerpt:
member  state        last result  ago     job
f1      done failed  timed out    1m ago  job

3 hidden (2 failed, timed out, 1 stopped)

redraws every 3s, ctrl-c to stop
exit: 0

Verify command: node --test test/member-board.test.js test/member-result.test.js
Exact final output:
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5611.673708
exit: 0

Progress: shared reasons fit eight columns sooner for both current and earlier hidden failures. No dependencies added.
Learned: shortening the prefix before removing a reason keeps the actionable detail at the same line budget. Extremely narrow board rows still overflow separately from this footer fix.
Task setup note: mission attach-task encountered an existing runner lock; created and claimed a separate bounded task without changing the mission.
next_push: remove duplicate age information from finished rows below 50 columns to keep the failure reason visible without wrapping.
layer: behaviors

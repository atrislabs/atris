# Split timeout follow proof

Live member follow now has a regression check for a timeout written in two pieces. The real CLI proof and frozen tests both exited 0.

Plan: incomplete write -> no event -> newline -> one timeout event -> no duplicate.

Edited this increment: test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md.
Produced: atris/runs/member-board-split-timeout-proof.py; this receipt.
Carry-forward: completed the existing merge from origin/codex/builder-continue-improving-atris-member-boar-20261014-191103. Reviewed already-resolved commands/mission.js signal callbacks and combined map notes; staged resolutions preserve closeSignal and both note sets. Existing unrelated unstaged test/member-board-last-result.test.js remains untouched.

Rerun: node --test test/member-board.test.js test/member-result.test.js
Output: tests 68; pass 68; fail 0; cancelled 0; skipped 0; todo 0; exit 0.

Real surface: python3 atris/runs/member-board-split-timeout-proof.py
Invokes: node bin/atris.js member board --json --follow
Output:
```text
snapshot received
incomplete timeout: no event after 1.2 seconds
{"member": "builder", "mission": "m-proof", "at": "2026-10-15T00:00:00.000Z", "kind": "finished", "text": "failed (timed out)", "ok": false}
completed timeout: exactly one event
exit: 0
```

Other commands: atris mission status mission-2026-10-14-continue-improving-atris-mem-52869ba8; git status; atris task list; atris; atris mission goal --json; atris task new/claim/note; git diff --check (exit 0); node --check commands/mission.js (exit 0).
Setup notes: brain activation was plan-only and did not write files. Mission attach-task was refused by its existing driver lock; a local task was created and claimed without changing mission policy.
Progress: one live regression strengthened; all 68 required tests green; partial and duplicate event assertions each cover a full polling interval.
next_push: Check a timeout line already half-written when the real follower starts.
layer: behaviors

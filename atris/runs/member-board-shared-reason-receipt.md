Shared failure reasons now survive smaller footers; real watch output and all 38 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-shared-reason-proof.py, atris/runs/member-board-shared-reason-receipt.md.

Plan: full shared reason -> drop "all" -> omit reason -> cut footer.
Change: compact footers omit "all" from shared current and earlier failure reasons before dropping the reason. Larger footers keep their existing wording.

Real surface command: python3 atris/runs/member-board-shared-reason-proof.py
Invokes: node bin/atris.js member board --watch in a real 40-column, 7-row terminal with isolated progress logs.
Output excerpt:
member  state        last result  ago     job
f1      done failed  timed out    1m ago  job

3 more not shown (3 failed, timed out)

redraws every 3s, ctrl-c to stop
exit: 0

Rerunnable verifier: node --test test/member-board.test.js test/member-result.test.js
Final output:
ℹ tests 38
ℹ suites 0
ℹ pass 38
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5622.346041
exit: 0

Progress: saves 4 columns for a shared reason; timeout stays at 40 columns instead of 44. Regression covers timeout, engine error, bad exit, earlier failures, and reason removal below the fitting boundary. Initial verification exposed an old expectation that discarded a now-fitting reason; updated that expectation and added a narrower fallback assertion.
next_push: shorten the more-not-shown prefix before cutting failure counts in windows below 36 columns.
layer: behaviors

Proof caveat: the task helper rerun through its login shell exited 1 (22 passed, 3 failed, 13 cancelled), saved in atris/runs/2026-10-14-task-bci-3-2026-10-14T20-20-39-098Z.json. The direct frozen command was rerun afterward and passed again: 38 passed, 0 failed, exit 0. Cause of the helper difference remains uninvestigated and belongs to a separate slice. Task moved to Review using the saved direct-run receipt. Brain compile was invoked in plan-only mode; no unrelated generated policy files were written.

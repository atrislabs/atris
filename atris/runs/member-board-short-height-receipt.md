Very short member boards keep their header within one to three lines; the real watch command and all 40 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-short-height-proof.py, atris/runs/member-board-short-height-receipt.md.
Plan: header -> urgent row if space permits -> failure summary, without a spacer in a three-line board.
Metric: a three-line board uses three lines instead of four; one- and two-line boards also respect their cap. One regression covers six height/older-run combinations. 40 tests passed, 0 failed.
Verify: node --test test/member-board.test.js test/member-result.test.js
Real surface: python3 atris/runs/member-board-short-height-proof.py invokes node bin/atris.js member board --watch in an 80-column, 6-row terminal, exit 0.
Limitation: at one board line only the header fits; rows and the failure summary need more space. Watch chrome in terminals of three rows or fewer remains a separate follow-up.
Learned: reserving a spacer and insisting on a member row makes the minimum board taller than the terminal budget.
next_push: Keep watch mode within terminals with three rows or fewer by shortening its redraw hint.

Real terminal output:
```
command: node bin/atris.js member board --watch (80 columns, 6 rows)
[2J[Hmember  state        last result                ago     job  last step
f1      done failed  failed (timed out) 1m ago  1m ago  job  -
3 more not shown (2 failed, all timed out, 1 stopped), the window is too short

redraws every 3s, ctrl-c to stop

exit: 0
```

Required test output, exit 0:
```
✔ ago reads like a person would say it (0.91225ms)
✔ board shows working, quiet, done ok, and done failed from fake logs (6.579208ms)
✔ a failed row says why when the finished line gives a reason (2.172833ms)
✔ the runner writes why a run failed and the board reads it back (3.232958ms)
✔ a narrow terminal trims job and last step so every line fits (1.534667ms)
✔ a busy row with an earlier failure shrinks its last result before it overflows (2.016917ms)
✔ a live run with a long name drops last step before it overflows 80 (1.235167ms)
✔ watch mode redraws at once when the window is resized (2.044083ms)
✔ a short window keeps the header and the newest rows, and says how many did not fit (2.3095ms)
✔ one to three board lines keep the header without scrolling away failures (1.553375ms)
✔ a short window keeps failed and stopped rows on screen ahead of newer ones (2.023541ms)
✔ short boards distinguish a hidden busy member earlier failure from a current failure (1.972917ms)
✔ compact footers drop all before dropping a shared failure reason (4.057584ms)
✔ tiny footers shorten the hidden prefix before cutting failure counts (1.261875ms)
✔ hidden failures that share a reason say it once in the count (1.803875ms)
✔ last step skips writes to the member own log (1.0205ms)
✔ members that finished over an hour ago hide unless --all (310.685125ms)
✔ board says nobody is working when every member is hidden (0.06875ms)
✔ atris member board reads ATRIS_PROGRESS_DIR for real (3809.7475ms)
✔ atris member board says so plainly when no member has a log (99.17075ms)
✔ progress lines turn into stream events (0.32025ms)
✔ follow emits only new full lines, picks up new members, survives truncation (2.432583ms)
✔ atris member board --json --follow streams one JSON object per line (157.538209ms)
✔ follow finishes a line that was half written before it started (1.743583ms)
✔ board shows a live run as alive with its engine, and a dead one as stopped (82.832958ms)
✔ member stop ends the run and everything it started, then logs finished: stopped (159.781208ms)
✔ member stop forces a run that ignores the polite signal (382.854084ms)
✔ member stop says nothing running for unknown, finished, untagged, or dead runs (95.909708ms)
✔ member stop leaves a reused pid alone when its command is no longer the engine (56.104084ms)
✔ member stop refuses system pids, its own group, and engines it does not know (6.951375ms)
✔ member stop leaves a same-named engine alone when it started at a different time (52.218834ms)
✔ member stop ignores engine names that are object keys (2.075ms)
✔ member stop needs the run token of that member in the live command (55.80075ms)
✔ member stop does not hard-kill a process that replaced the run during the grace wait (257.235375ms)
✔ member stop needs the marker to open the prompt, as whole words (57.21825ms)
✔ member result args: one member, optional iso --since, json (1.629083ms)
✔ one obvious number: a single percent, dollar, or count; two different values means none (1.678208ms)
✔ reads the newest run, its worktree receipt, and files made after it started (14.127625ms)
✔ --since widens the window; a member with no runs still reads its own folder (1.23575ms)
✔ an unknown member is an error, printed as json with exit 1 (1.117042ms)
ℹ tests 40
ℹ suites 0
ℹ pass 40
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5706.540375
```
layer: behaviors

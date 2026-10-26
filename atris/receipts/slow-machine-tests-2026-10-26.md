# Busy-machine test proof, 2026-10-26

Objective: these four test files pass under heavy CPU load without losing their behavior checks.

Plan: inspect -> adjust test timing -> three normal runs -> three loaded runs -> stop burners -> commit locally.

Changed files:

- `test/engine-ask.test.js`: 15s for immediate replies and no-output exits, plus deadline-based observation of live logs and receipts; hanging timeout cases keep their original short budgets.
- `test/engine-validate.test.js`: 15s for immediate fake referee replies, including malformed output.
- `test/mission-run-reliability.test.js`: 15s polling deadlines; the fake runner waits for explicit release after the competing driver checks its lock, then exits and is joined before cleanup.
- `test/member-board.test.js`: observe both initial draw and actual redraw before stopping the watch, with a 15s deadline and the original output and signal checks.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: navigation for these timing checks.
- This proof file.

No changes under `lib/`, `commands/`, or `bin/`. `test/gm-phone-motion.test.js:102` measures fade smoothness (frame count, opacity change, absence of jumps), so it remains unchanged.

Each command below ran directly, without a pipeline, three times before burners and three times with burners:

```sh
node --test --test-reporter=tap test/engine-ask.test.js
node --test --test-reporter=tap test/engine-validate.test.js
node --test --test-reporter=tap test/mission-run-reliability.test.js
node --test --test-reporter=tap test/member-board.test.js
```

| file | normal 1 | normal 2 | normal 3 | loaded 1 | loaded 2 | loaded 3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `test/engine-ask.test.js` | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 |
| `test/engine-validate.test.js` | 13/13 | 13/13 | 13/13 | 13/13 | 13/13 | 13/13 |
| `test/mission-run-reliability.test.js` | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| `test/member-board.test.js` | 23/23 | 23/23 | 23/23 | 23/23 | 23/23 | 23/23 |

All 24 file invocations exited 0. Every run reported zero failures, cancellations and skips. The earlier combined command also exited 0 with 65 passed:

```sh
node --test test/engine-ask.test.js test/engine-validate.test.js test/mission-run-reliability.test.js test/member-board.test.js
```

For each loaded round, started fresh burners with the requested 120-second loop:

```sh
for i in $(seq 1 24); do node -e "const e=Date.now()+120000;while(Date.now()<e){}" & done
```

All 24 burner processes were still alive at the end of each loaded round, then terminated by their saved PIDs. A final signal-0 check found none of the 72 launched burner PIDs alive.

Observed one-minute machine load at the end of each round:

| run | before burners | with 24 burners |
| --- | ---: | ---: |
| 1 | 455.51 | 401.32 |
| 2 | 431.55 | 385.90 |
| 3 | 410.28 | 372.28 |

The machine was already heavily loaded before the additional burners; these were not idle-machine baseline runs.

Raw TAP outputs and JSON summaries from this session: `/tmp/atris-slow-machine-proof-IA2yGT/`.

Whitespace check: `git diff --check`, exit 0, no output.

The combined command passed again during completion recording, with the execution receipt at `atris/runs/2026-10-26-task-sm1-1-2026-10-26T10-41-33-050Z.json`.

The task is ready for review. No acceptance, merge, or push is authorized.

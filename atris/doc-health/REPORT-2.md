# Document health, part two

## Result

Implemented the four requested changes on the supplied branch, with a commit after each item. Final reader review also restored full-command lookup for unattended work. No pull request was opened. No dependencies were added.

The required compact layout works and preserves task counts, but the backend size target is not met: 30,124 characters versus a target under 12,000. The original task titles alone occupy 11,528 characters, and the required approval lines occupy another 8,171, before owners, IDs, verification previews, or headings. Reaching 12,000 would require cutting content the brief says to keep.

## Files and behavior

| Files | Change |
| --- | --- |
| `lib/task-db.js` | Default task rows contain ID, original title, existing routing/decision tags, owner, and the first 60 characters of the verification preview. In Progress and Review retain approval detail; Completed retains its eight-row default cap. `ATRIS_TODO_RENDER=full` restores the previous detailed format. |
| `lib/todo.js`, `lib/todo-fallback.js`, `lib/state-detection.js`, `lib/first-minute.js` | Shared parsing keeps row owners and verification previews out of task titles. Startup's markdown fallback now counts Review rows without treating them as certified. Preview commands are display-only and are never run or imported as full verification commands; the database and `atris task show <ID>` retain the full commands. Compact boards automatically resolve full commands from an existing database, even without the legacy opt-in. Display references prevent duplicate rows when titles contain tags. |
| `bin/atris.js`, `commands/doc-health.js` | Startup calls `computeDocHealth(root)` directly and catches failures. The score, one-hop percentage, and approximate token count appear after the current-work summary; missing questions get the requested hint. This branch has no truth row in `showWelcomeVisualization()`. No subprocess is used by the new score computation. |
| `commands/doc-health.js` | Boot full credit extends through 80,000 characters, decreases linearly to zero at 200,000, and clamps outside the range. Frontmatter statuses retired, parked, and archived remove members from the freshness denominator. Retired/superseded features follow parked's existing exemption from stale flags. `_archive` and `_templates` are excluded from feature coverage, freshness, and duplicate checks. |
| `test/todo-compact.test.js`, `test/doc-health.test.js` | Generated-render reader coverage; all lanes and owner fallback; display-only previews; full mode; startup output, fault tolerance, score equivalence and reduced reads; scoring boundaries; each requested exclusion. |
| `test/commands.test.js`, `test/task-explanation.test.js`, `test/workflow-delegation.test.js` | Update old rendering assertions while retaining full-mode, raw-data, import, and dispatch checks. |
| `README.md`, `atris/doc-health/build.md`, `atris/MAP.md` | Updated threshold, exclusions, and navigation pointers. |

## Reader audit

Searched the repository for `TODO.md`, `parseTodo`, `state-detection`, `getTaskGlance`, `accept`, and `reviews`.

- `lib/todo.js` shares `lib/todo-fallback.js` with import/render/scaffold paths. Autopilot, run, status, and scorecard inherit the compatible parser; database rows continue to supply full commands.
- State detection and the first-minute fallback now use that parser for titles. Existing Task: blocks remain supported by state detection.
- `commands/task.js` accept/reviews read durable task rows and proof metadata, so the shorter markdown cannot grant approval or weaken certification.
- Now, brain, console, next-moves, and launchpad use headings, task bullets, endgame metadata, or raw text; the necessary headings, bullets, tags, and preserved sections remain.
- Workflow, activate, soul, member, visualize, and context readers consume task state or raw document text. Legacy clean/verify Task:/### readers do not depend on the removed explanation fields.

## Backend size check

Read the backend's saved task view and TODO file without changing either. Rendered the same saved rows in compact and full mode, then parsed each section to compare counts.

Measured at: `2026-09-15T21:43:50.956Z`.

| Measure | Characters |
| --- | --- |
| Existing TODO file | 94,476 |
| Full-mode render | 102,101 |
| Compact render | 30,124 |
| Original titles | 11,528 |
| Required approval lines | 8,171 |
| Verification previews | 4,480 |

| Section | Existing | Full | Compact |
| --- | --- | --- | --- |
| Backlog | 41 | 41 | 41 |
| In Progress | 25 | 25 | 25 |
| Review | 35 | 35 | 35 |
| Blocked | 0 | 0 | 0 |
| Completed | 8 | 8 | 8 |

The compact result is about 68% smaller than the existing file. Eight archived rows in the saved task view remain outside the rendered board, as before.

## Startup timing

Measured the direct computation ten times in each real workspace. Module load was measured once separately and included conservatively in the first-call total below. A separate detailed run confirmed identical score parts. The summary avoids second-hop document reads for one-hop questions and stops member log scans once recent activity proves freshness; the detailed command still reports exact newest-log timestamps.

| Workspace | First call plus module load | Median calculation | Maximum calculation |
| --- | --- | --- | --- |
| CLI | 25.69 ms | 3.77 ms | 18.93 ms |
| Backend | 47.69 ms | 12.37 ms | 40.93 ms |

These are observed local timings, not a bound on slow disks or heavily loaded machines.

## Focused verification

### Compact render

Command: `node --test test/todo-compact.test.js test/task-explanation.test.js test/workflow-delegation.test.js`

Exit: 0

```text
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2913.859417
```

### Task readers

Command: `node --test --test-name-pattern="task render|task import|task accept|task reviews|todo|parseTodo|state detection|getTaskGlance" test/commands.test.js`

Exit: 0

```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 20697.51575
```

### Startup

Command: `node --test test/doc-health.test.js test/boot-impression.test.js`

Exit: 0

```text
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13344.295375
```

### Threshold

Command: `node --test test/doc-health.test.js`

Exit: 0

```text
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7156.644291
```

### Exclusions

Command: `node --test test/doc-health.test.js`

Exit: 0

```text
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5979.879084
```

### Final unattended-work compatibility

Command: `node --test test/todo-compact.test.js test/task-explanation.test.js test/workflow-delegation.test.js test/autopilot-command.test.js test/autopilot-plan-review.test.js`

Exit: 0

```text
ℹ tests 61
ℹ suites 0
ℹ pass 61
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10525.927084
```

## Full suite

The first full run began before the final unattended-work reader fix. Command: `node --test`. Exit: 1.

```text
ℹ tests 4717
ℹ suites 22
ℹ pass 4705
ℹ fail 12
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 984544.451208
```

The final complete run includes the unattended-work reader fix. Command: `node --test`. Exit: 1. Exact summary:

```text
ℹ tests 4718
ℹ suites 22
ℹ pass 4713
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 801803.333291
```

Exact failing test locations and names:

```text
test at test/engine-ask.test.js:325:1
✖ timeout kills only the process group launched for that ask (5135.168792ms)
test at test/mission-run-reliability.test.js:211:1
✖ the mission lock names the live tick subprocess until it exits (2705.530708ms)
test at test/one-lap-runtime.test.js:363:1
✖ one natural sentence runs one real isolated lap to verified Review without merging master (51401.376125ms)
test at test/one-lap-runtime.test.js:470:1
✖ one lap honors trusted operator Git URL rewrites for protected remote access (47779.314333ms)
test at test/spaceship-supervisor.test.js:17:1
✖ spaceship supervisor survives halts and classifies outcomes (10118.577208ms)
```

No document-health, compact-board, task-reader, acceptance, or review tests failed. The remaining failures concern process cleanup, live mission lock timing, sandbox subprocess timeouts, and a supervisor alert deadline. These paths were not changed. The full suite is not green; separate passing checks do not change its exit status.


## Isolated timing recheck

Command: `node --test --test-name-pattern="timeout kills only the process group launched|dispatchToEngine appends engine chunks|mission lock names the live tick|spaceship supervisor survives halts" test/engine-ask.test.js test/fleet.test.js test/mission-run-reliability.test.js test/spaceship-supervisor.test.js`

Exit: 0. Exact output:

```text
✔ timeout kills only the process group launched for that ask (115.325125ms)
✔ dispatchToEngine appends engine chunks to its live log before the engine exits (1126.106917ms)
✔ the mission lock names the live tick subprocess until it exits (2429.314083ms)
✔ spaceship supervisor survives halts and classifies outcomes (9315.250917ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9392.168
```


## Sandbox comparison

The earlier full-run Git-filter timeout passed in both a temporary copy of the original source and the changed source. Command: `node --test --test-name-pattern="one lap raw tree import never executes worker-controlled Git filters" test/one-lap-runtime.test.js`. Both exited 0. The original-source copy omitted tracked symlinks to external agent configuration.

Changed-source output:

```text
✔ one lap raw tree import never executes worker-controlled Git filters (24316.138292ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 24435.387
```


The two sandbox timeouts from the final full run also passed separately. Command: `node --test --test-name-pattern="one natural sentence runs one real isolated lap|one lap honors trusted operator Git URL rewrites" test/one-lap-runtime.test.js`. Exit: 0. Exact output:

```text
✔ one natural sentence runs one real isolated lap to verified Review without merging master (12766.757041ms)
✔ one lap honors trusted operator Git URL rewrites for protected remote access (16937.811209ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 29762.467584
```

All five failures from the final full run passed isolated rechecks. Their full-suite failures remain recorded above.

## Remaining limits

- The backend render is 30,124 characters. The requested 12,000-character target cannot coexist with the original titles and required approval details in this snapshot. No task rows or required approval details were dropped, and no backend files were changed.
- `node --test` exits 1 with five failures in process/sandbox checks. All five pass isolated rechecks; no changes were made to their timing limits or implementation.

Final whitespace check: `git diff --check`, exit 0, empty output.

Proof was moved to Review with `atris task ready DHB-1 --verify "node --test test/doc-health.test.js test/todo-compact.test.js"`; the command exited 0. Receipt: `atris/runs/2026-09-15-task-dhb-1-2026-09-15T22-08-03-915Z.json`. The task was not accepted.

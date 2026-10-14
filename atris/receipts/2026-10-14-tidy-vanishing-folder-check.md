# Tidy hides the reason a folder disappeared

The real tidy command reproduced the final-check race twice, exit 0. The required tests passed: 19 passed, 0 failed, exit 0. This increment adds evidence, not a cleanup repair.

Plan: resolve folder -> check activity -> move generated folder -> read failure output -> check retained files and branches.

## Verdict

Proceed with changes. When the final activity check fails, tidy keeps the branch but reports only a metadata lookup failure. If the folder has disappeared, use the existing main-repository lock lookup to report the missing folder and retained lock path and age. Preserve the branch and avoid adding a removal record.

## Real command proof

Run `node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, exit 0. The script invokes `node bin/atris.js member tidy --dir <generated copies>` against two real local Git repositories and remotes. A forwarding Git executable moves only the generated copy during the final activity check and then invokes real Git using the original directory. The fixture remains on disk for inspection.

Actual output excerpt:

```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-cf2YXo
kept  landed-copy  could not check git activity: could not locate git metadata
cli exit: 0
missing folder reported: false
retained lock reported: no lock created
kept  landed-copy  could not check git activity: could not locate git metadata
cli exit: 0
missing folder reported: false
retained lock reported: false
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-cf2YXo/locked/repo/.git/worktrees/landed-copy/locked (7200s old)
both timing cases reproduced; moved files and branches retained; no removal recorded
```

The proof asserts the current omission so it can reproduce the defect without adding a failing required test. Update its output assertions when the repair lands. It also checks both branches, both moved README files, the retained lock, and the absence of removal records.

## Required verification

Run `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0.

```text
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12817.528667
```

Files: `atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and `atris/team/architect/logs/2026-10-14.md`. Task commands: mission status, mission goal, task list, task new, task claim, task note, and task ready. Inspected Git status and current member identity before choosing this slice. Existing entrypoint changes were left alone.

Review handoff: the review recorder first ran the bare command in a login shell and returned exit 1, 18 passed and 1 failed. `/bin/sh -lc 'command -v node; node --version'` selected `/usr/local/bin/node`, v20.18.0. The bare frozen command in the working shell selected Node v25.6.1 and passed. Recording review with `/opt/homebrew/bin/node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` passed, exit 0, and moved the task to review. Receipt: `atris/runs/2026-10-14-task-acw-25-2026-10-14T20-10-36-409Z.json`. The explicit runtime requires a second review for automatic landing; no task acceptance was attempted.

Progress: two real timing cases reproduced; no fixture files lost; no removal recorded; required tests remain green.

next_push: Teach member tidy's final activity failure to report a missing folder and its retained lock path and age, with a real timing regression test.

layer: behaviors

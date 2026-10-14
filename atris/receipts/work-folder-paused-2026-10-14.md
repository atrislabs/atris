Paused Git work now has a six-case proof across five cleanup paths; the real cleanup command and all 34 required tests passed, exit 0.

Objective: prove the inherited shared report for paused Git work, one bounded increment.
Plan: paused marker -> actual cleanup -> same words -> folder retained -> no removal log.
Scope: tests and proof only; no cleanup implementation or member instructions changed.

Files edited: test/member-tidy.test.js, atris/receipts/work-folder-report-probe.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md.
Artifact produced: atris/receipts/work-folder-paused-2026-10-14.md.
The new comparison uses real Git repositories and runs tidy, reap, cleanup, fleet disposal and autopilot regression execution. Both rebase markers, merge, cherry-pick, revert and bisect must retain the folder and use identical words. Autopilot's verification command writes the actual marker inside its new copy. No mocks replace the cleanup code.
Limitation: these are Git activity markers planted in disposable repositories, not conflicted operations created through a full Git workflow.

Real command: node atris/receipts/work-folder-report-probe.js
Invocations: node bin/atris.js worktree cleanup --base HEAD, then node bin/atris.js worktree cleanup --base HEAD --apply for each of the six paused markers, in a disposable repository.
Exact output excerpt for the final case:
    command: node bin/atris.js worktree cleanup --base HEAD --apply (BISECT_LOG fixture)
    cleanup: applied base=HEAD
    removeds: 0
    cache_pruneds: 0
    kept: 2
    held: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-folder-report-daKASZ/copy a bisect is paused
    exit: 0
    paused cases: 6; folders retained: 6; removals logged: 0
Every child exited 0 and the probe exited 0. The probe asserts full paths, registration in Git's worktree list, and absence of removal records before removing its own temporary fixture.

Rerun: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0
Exact summary:
    ℹ tests 34
    ℹ suites 0
    ℹ pass 34
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 81518.773708
Additional check: git diff --check, exit 0.
Metric: 30 paused-state/path comparisons, six real CLI apply cases, zero removed paused folders, zero failed required tests.
Cost: the new comparison took 39638.6245 ms on this computer while other jobs were running.

State inspected: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-cd299a9a; atris task list --status open; atris task list --status review; atris mission goal --json.
Task commands: atris task new "Prove paused Git reports across cleanup paths" --tag workspace; atris task claim ACW-2 --as architect; atris task note ACW-2.
Brain activation and compile ran in preview mode, exit 2, and wrote no compiled policy files. Some referenced compiled files are absent. No broad policy regeneration was needed for this proof.
The generated TODO view is restored to its original content to preserve the established board rather than replace it with this checkout's smaller local database.

Handoff: atris task ready ACW-2 reran the exact required check, exit 0, and moved the task to Review. Gate receipt: atris/runs/2026-10-14-task-acw-2-2026-10-14T23-12-45-464Z.json. The first handoff attempt was rejected because its result did not explain the operator benefit; the revised result explains reduced risk of losing unfinished work.
Landing: evidence committed and pushed to the current remote branch; no acceptance or merge.

Stop: the single increment passed its verification. The eight-hour mission remains running with its existing owner; no second slice, new mission, acceptance or merge started.
next_push: prove that simultaneous paused work and a lock in an additional Git store retain every store and report the chosen hold consistently.
layer: behaviors

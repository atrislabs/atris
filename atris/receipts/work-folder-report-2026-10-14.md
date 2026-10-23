Shared cleanup reports now name held locks consistently; the real CLI preview and all 33 required tests passed.

Objective: finish the inherited shared Git hold report, one bounded increment.
Plan: held folder -> shared check -> shared report -> keep folder.
Verdict: proceed with consolidation; preserve the pre-delete guard and prove it using real Git locks.

Changed code: commands/worktree.js, commands/land.js, commands/autopilot.js, lib/fleet.js, lib/member-tidy.js.
Changed tests: test/worktree-removal-guard.test.js, test/member-tidy.test.js.
Navigation: atris/MAP.md, atris/refs/MAP-NOTES.md.
Proof artifact: atris/receipts/work-folder-report-probe.js.
Member record: atris/team/architect/logs/2026-10-14.md.
Receipt: atris/receipts/work-folder-report-2026-10-14.md.

Real surface command: node atris/receipts/work-folder-report-probe.js
It invokes node bin/atris.js worktree cleanup --base HEAD in a fresh temporary repository.
Output excerpt:
    cleanup: dry-run base=HEAD
    candidates: 0
    cache_candidates: 0
    kept: 2
    held: <temporary copy> git holds <temporary repository>/.git/worktrees/copy/index.lock, 3 h old
    exit: 0
    locked folder remains: yes
The probe checks the full actual path. Placeholders above abbreviate only this receipt.

Rerun: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0
Exact summary:
    ℹ tests 33
    ℹ suites 0
    ℹ pass 33
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 33278.828875
Additional check: git diff --check, exit 0.
Metric: five cleanup paths use one hold report; one new cross-path regression; no required checks failed.

State commands: atris mission status mission-2026-10-14-continue-work-folder-protect-cd299a9a; atris task list --status open; atris mission goal --json; atris task claim ACW-1 --as architect; atris task note ACW-1; atris task ready ACW-1 --proof <proof above>.
Mission attachment was refused because the live runner holds the lock. No lock was cleared and no mission settings changed. The native goal lookup returned no candidate.
Brain activation and compile ran in preview mode and wrote no compiled policy files.
The requested earlier branch has only two log commits missing here; its code is already carried forward with subsequent guard repairs. No old code was restored.
The task-generated TODO view was restored to its prior content to avoid replacing the larger existing view with this checkout's small local database.

Landing: code and evidence committed and pushed to origin. Task is in Review after its own required check exited 0; gate receipt: atris/runs/2026-10-14-task-acw-1-2026-10-14T23-06-22-056Z.json. No acceptance or merge performed.
The commit load check initially rejected the probe because importing it executed the CLI in the staged-file mirror. The probe now runs only as an entry point; its real CLI proof passed again and the commit check passed.

Stop: this increment passed its required verification. No second slice started; the eight-hour mission remains with its runner.
next_push: prove that every cleanup path reports paused Git work consistently, including autopilot's retained regression folder.
layer: behaviors

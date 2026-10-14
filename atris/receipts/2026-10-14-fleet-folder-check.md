# Fleet folder cleanup decision

Added a real-runtime audit of fleet cleanup. It reproduced deletion of folders with two-hour-old private and shared Git locks, with no removal record. The audit and required checks exited 0; production behavior is unchanged.

Verdict: proceed-with-changes. The single risk is deleting the parent folder after keeping a locked child. Require one keep decision for the whole review-folder group before removing any child, preserve the exact lock paths and ages, check running programs, and log each successful removal through the existing recorder. Do not change execution restrictions. This decision card proposes a protected-boundary implementation; it does not approve or land one.

Plan: real lock -> inspect whole folder group -> keep whole group with path and age, or remove safely -> record successful removals.

## Runtime proof

Command: `node atris/receipts/2026-10-14-fleet-folder-check.js`
Exit: 0.

The script loads the actual fleet module source with an appended in-memory export for its private cleanup routine. No production source, imported helper, Git operation, or filesystem operation is replaced. This proves the routine's behavior with real Git repositories; it does not exercise the full dispatch command or engine lifecycle. Only freshly created disposable fixture folders are removed. The remaining fixture repository is retained.

Actual output:
```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-kcGefB
private before cleanup: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-kcGefB/review-70FHOy/objects.git/worktrees/work/index.lock (7200s old)
{"kind":"private","folderKept":false,"lockKept":false,"parentKept":false,"removalRecorded":false}
shared before cleanup: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-kcGefB/review-mAv1gC/objects.git/refs/heads/master.lock (7200s old)
{"kind":"shared","folderKept":false,"lockKept":false,"parentKept":false,"removalRecorded":false}
audit complete; surviving fixture data retained for inspection
```

The audit asserts real setup and exact lock detection, then reports survival and logging outcomes. Its successful exit is evidence that the audit ran, not that cleanup is safe; it remains useful after a repair.

## Required check

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual final output:
```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3189.718959
```

## Handoff

Files edited: `atris/receipts/2026-10-14-fleet-folder-check.js`, this decision card, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`. Task commands also regenerate `atris/TODO.md`; existing edits there and in `bin/atris.js` are excluded from staging.

Commands run: `git status --short`; `atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9`; `atris brain activate --root . --verify`; `atris`; `atris mission goal --json`; `atris task list`; `atris task new`; `atris task claim`; `atris task note`; targeted reads and searches; the runtime and required check commands above. Save steps: `git diff --check`, explicit file staging, `git commit`, `git push`, and `atris task ready` with this receipt as proof. Brain activation returned exit 2 with a write plan, and no compiled files were created.

Progress: two real lock cases reproduced, two unlogged removals observed, twelve required checks passed, zero production changes, zero new dependencies. The next implementation must add regression coverage for the whole parent group, not only the work folder.
next_push: Guard fleet review-folder disposal as one group so a kept locked child cannot be deleted through its parent, and log successful removals.
layer: beliefs

## Independent review repository follow-up

Extended the audit to prove a separate review repository lock is invisible to a work-folder-only check. Production cleanup still deletes the whole group and writes no removal record.

Verdict: proceed-with-changes. The specific failure mode is inspecting only the work folder, then deleting a separate repository with active Git metadata through the parent. Before any child removal, inspect both repositories with the existing Git activity helper and check running programs across the parent. Keep the entire group on either refusal, report exact lock paths and ages, and record each successful removal in the trusted root. Implementation at this execution boundary remains a decision for the caller; no production code was changed or approved.

Plan: work repository + independent review repository -> inspect both -> keep entire parent on refusal -> otherwise remove and record.

Command: `node atris/receipts/2026-10-14-fleet-folder-check.js`
Exit: 0. Actual additional output:
```text
quarantine case: work-folder-only check reports safe
quarantine before cleanup: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-Ik0BzZ/review-3T6DHM/quarantine.git/refs/heads/review.lock (7200s old)
{"kind":"quarantine","folderKept":false,"lockKept":false,"parentKept":false,"removalRecorded":false}
audit complete; surviving fixture data retained for inspection
```

The new case asserts that the work-folder check reports safe, the independent lock is detected with its exact age, and current cleanup deletes both lock and parent without a log. These assertions reproduce the current defect, rather than certify safe cleanup. Change them to preservation assertions when repairing the routine. The fixture uses newly created disposable repositories only, with real Git and unchanged imported helpers.

Required check: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual final output:
```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2989.239708
```

Files edited: `atris/receipts/2026-10-14-fleet-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and `atris/team/architect/logs/2026-10-14.md`. Existing `bin/atris.js` and rendered `atris/TODO.md` edits are excluded. Commands: mission status, task list/new/claim/note/ready, brain activation, workspace status, mission goal lookup, targeted reads, the two proof commands above, brain compile, whitespace check, explicit staging, commit, and push. Artifacts: retained disposable fixture `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-Ik0BzZ`, extended audit, and this decision card.

Progress: one additional real lock case, three reproduced unlogged deletions overall, twelve required checks passed, zero dependencies and zero production changes.
next_push: Check both review repositories before removing any child, preserve the whole group on activity, and record successful removals.
layer: beliefs

## Running program follow-up

Extended the cleanup audit to reproduce deletion around a running program. The actual cleanup routine and required checks both exited 0; all twelve required tests passed.

Verdict: proceed-with-changes. The single failure mode is checking activity only under the work folder before removing the parent, which also contains an independent repository. The real process scan reports that repository's running program under the parent, while the work-folder scan reports clear. Check both repositories for Git activity and the entire parent for running programs before removing any child. Keep the entire group if either check refuses or cannot run. This is a decision card, with no production implementation or approval.

Plan: both repositories + parent process scan -> keep whole group on activity or uncertainty -> otherwise remove and record.

Runtime command: `node atris/receipts/2026-10-14-fleet-folder-check.js`
Exit: 0. Actual new output:
```text
running before cleanup: live program in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-zEgagN/review-oNpBL9/quarantine.git; work-folder-only scan reports clear
{"kind":"running","parentKept":false,"programAlive":true,"removalRecorded":false}
audit complete; surviving fixture data retained for inspection
```

The audit starts a real child program in disposable review metadata, asserts the actual scan detects activity under the parent but not the work folder, and confirms both repositories have no Git locks. It invokes unchanged production cleanup and proves the parent is gone while the program remains alive. The child is stopped and awaited in cleanup. No filesystem, process scan, or Git helper is replaced. Success reproduces a defect; it does not certify safe removal. Change the deletion assertion to preservation when implementing the repair.

Rerun required check: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual output excerpt:
```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2770.98475
```

Files edited: `atris/receipts/2026-10-14-fleet-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and `atris/team/architect/logs/2026-10-14.md`. Task commands regenerate `atris/TODO.md`; that rendered file, existing `bin/atris.js` changes, and the prior result entry in the member log are excluded from staging.

Commands run: mission status, git status, brain activation, workspace status, mission goal lookup, task list/new/claim/note/ready, targeted reads and searches, the two proof commands above, brain compile, whitespace check, explicit staging, commit, and push. Brain activation returned exit 2 with a write plan. No compiled files were created. Artifacts: extended runtime audit, this decision card, and retained disposable fixture `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-zEgagN`.

Progress: one additional real running-program case, four reproduced unlogged deletions overall, twelve required checks passed, zero production changes and zero new dependencies.
next_push: Implement one keep decision for both review repositories and the whole parent process scan before any removal, then log successful removals.
layer: beliefs

## Sibling copy follow-up

Added a real sibling-copy lock case. The unchanged cleanup routine deleted its two-hour-old lock even though checks of the main copy and shared repository both reported safe. The runtime audit exited 0 and all twelve required tests passed, exit 0.

Verdict: proceed-with-changes. The single risk is removing shared Git storage without checking private metadata belonging to every copy inside the removal group. Inspect those copies as well as both repositories before any child removal; keep the entire group on activity or uncertainty, report exact lock paths and ages, and record successful removals. This evidence does not approve or implement a change at the execution boundary.

Plan: enumerate copies in group -> check each copy and both repositories -> keep whole group on refusal -> otherwise remove and record.

Runtime command: `node atris/receipts/2026-10-14-fleet-folder-check.js`
Exit: 0. Actual additional output:
```text
sibling case: work-folder and shared-repository checks both report safe
sibling before cleanup: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-4IISwG/review-WoPMiq/objects.git/worktrees/sibling/index.lock (7200s old)
{"kind":"sibling","folderKept":false,"lockKept":false,"parentKept":false,"removalRecorded":false}
audit complete; surviving fixture data retained for inspection
```

The existing audit exposes the actual private routine in memory, uses real Git repositories and unchanged helpers, and removes only newly created disposable fixtures. The new case asserts that both narrower checks report safe, the sibling check detects the exact lock path and age, and cleanup deletes the parent and lock without a removal record. Successful execution reproduces unsafe behavior, rather than certifying safe removal. Retained fixture: `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-4IISwG`.

Required rerun command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual final output:
```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2925.108333
```

Files edited: `atris/receipts/2026-10-14-fleet-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and the new entry in `atris/team/architect/logs/2026-10-14.md`. Existing changes to `bin/atris.js`, rendered `atris/TODO.md`, and the earlier member-log result are excluded from staging.

Commands run: mission status, task list/new/claim/note/ready, Git status and remote lookup, workspace status, mission goal lookup, brain activation, targeted reads/search, the runtime and required rerun commands above, brain compile, whitespace check, explicit staging, commit, and push. Brain activation and compilation produced write plans only; no generated policy was changed.

Progress: one additional real lock case, five reproduced unlogged deletions overall, twelve required tests passed, zero production changes and zero new dependencies.
next_push: Include every linked copy's private Git metadata in the whole-group keep decision before removing shared storage.
layer: beliefs

## Outside linked copy follow-up

Added a real outside-copy case to the cleanup audit. The actual cleanup routine ran with exit 0, and the required check passed with twelve tests, zero failures, exit 0. The outside folder survives but Git status fails after its shared metadata is deleted. This is evidence of unsafe cleanup, not a production repair.

Verdict: proceed-with-changes. The single risk is limiting enumeration to copies physically inside the removal group. Enumerate every copy registered with shared Git storage, including outside paths, and keep the group when a linked copy is active or its state cannot be checked. Inspect private locks with exact paths and ages before any removal. This advisory evidence neither changes production behavior nor approves deletion of user data.

Plan: shared repository registrations -> every linked copy -> activity check -> keep group on refusal -> otherwise remove and record.

Runtime command: `node atris/receipts/2026-10-14-fleet-folder-check.js`
Exit: 0. Actual additional output:
```text
outside case: work-folder and shared-repository checks both report safe
outside before cleanup: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-XcgLwb/review-ycPiP7/objects.git/worktrees/outside-review-ycPiP7/index.lock (7200s old)
{"kind":"outside","folderKept":false,"lockKept":false,"parentKept":false,"removalRecorded":false}
{"kind":"outside","outsideFolderKept":true,"outsideGitStatusExit":128,"error":"fatal: not a git repository: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-XcgLwb/review-ycPiP7/objects.git/worktrees/outside-review-ycPiP7"}
```

The disposable fixture uses unchanged production cleanup and real Git operations. Git status succeeds in the outside copy before cleanup, its private lock is exactly two hours old, and both narrower activity checks report safe. After cleanup the copy remains, the lock and parent are gone, no removal was recorded, and Git status fails with exit 128. Retained fixture: `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-XcgLwb`. Change defect-reproduction assertions to preservation assertions when repairing cleanup.

Required rerun command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual final output:
```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2807.21075
```

Files edited: `atris/receipts/2026-10-14-fleet-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and the new member-log entry in `atris/team/architect/logs/2026-10-14.md`. Task commands regenerate `atris/TODO.md`; existing changes there, in `bin/atris.js`, and earlier member-log entries are excluded from staging.

Commands run: brain activation, mission status and goal lookup, workspace status, task list/new/claim/note/ready, Git status/branch/remote lookup, targeted reads/searches, the runtime and required check above, brain compile, whitespace check, explicit staging, commit, and push. Brain activation returned exit 2 with a write plan; compilation is likewise plan-only. Artifacts: extended audit, this decision card, retained disposable fixture, navigation updates, and member log.

Progress: one additional reproduced failure, six audit cases overall, twelve required checks passed, zero new filenames, zero dependencies, zero production changes.
next_push: Enumerate all registered linked copies, including outside paths, before allowing shared Git storage removal.
layer: beliefs

## Outside running program follow-up

Added one outside-running-copy case, verified by the real cleanup audit and twelve required passing tests, both exit 0. The real process scan reports the parent clear while detecting the child program in a registered outside copy. Cleanup deletes shared Git files while that program stays alive. This reproduces a defect; it is not a production repair.

Verdict: proceed-with-changes. The single risk is scanning only the parent for running programs before deleting shared metadata needed by outside copies. Enumerate registered copies and scan their real paths as well as the parent before removing any child. Keep the entire group on activity or uncertainty. No execution boundary was changed or approved.

Plan: registered copies -> process scan for each copy and parent -> keep group on activity -> otherwise guarded removal and log.

Runtime command: `node atris/receipts/2026-10-14-fleet-folder-check.js`
Exit: 0. Actual additional output:
```text
outside-running before cleanup: live program in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-sB7mUK/outside-review-xyFxi8; parent scan reports clear
{"kind":"outside-running","outsideFolderKept":true,"outsideGitStatusExit":128}
{"kind":"outside-running","parentKept":false,"programAlive":true,"removalRecorded":false}
audit complete; surviving fixture data retained for inspection
```

The case uses real Git registration, verifies Git status succeeds before removal, and detects the live child with the existing process scan. No helper or filesystem operation is replaced. Both repositories and the outside copy report no Git locks. The program is stopped and awaited after proof. The disposable fixture is retained at the path above. Replace deletion assertions with preservation assertions when implementing protection.

Required rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual output:
```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3314.443375
```

Files edited: `atris/receipts/2026-10-14-fleet-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and the new evidence entry in `atris/team/architect/logs/2026-10-14.md`. Existing router, rendered task view, and earlier log edits are excluded from staging.
Commands run: mission status, Git status/remote lookup, task list/new/claim/note/ready, brain activation, workspace status, mission goal lookup, targeted reads, runtime audit, required rerun, brain compile, whitespace check, explicit staging, commit, and push. Brain activation and compilation only propose writes; missing compiled files were not created. Artifacts: extended audit, decision card, retained disposable fixture, navigation updates, and member evidence.
Progress: one new real failure case, seven cases overall, twelve required tests passed, zero production changes, zero dependencies, zero new filenames.
next_push: Scan running programs in every registered linked copy before removing shared Git storage.
layer: beliefs

## Idle outside copy follow-up

Added an idle outside-copy case, verified by the real cleanup audit and twelve passing required tests, both exit 0. Cleanup breaks the registered outside copy despite every Git activity and process check reporting clear. This is defect evidence, not a production repair.

Verdict: proceed-with-changes. The single risk is treating absence of activity as proof that shared Git storage is disposable. Preserve shared storage whenever any registered copy outside the removal group still depends on it, even when idle. Enumeration failure must also keep the group. No production execution boundary is changed or approved.

Plan: registered copies -> outside dependency exists -> keep shared storage and group.

Runtime command: `node atris/receipts/2026-10-14-fleet-folder-check.js`
Exit: 0. Actual additional output:
```text
outside-idle before cleanup: all git activity and process checks report clear
{"kind":"outside-idle","outsideFolderKept":true,"outsideGitStatusExit":128,"removalRecorded":false}
audit complete; surviving fixture data retained for inspection
```

The case checks real registration and clean Git status before cleanup, no Git locks in either repository or outside copy, and no running programs in the parent or outside copy. Unchanged cleanup then deletes shared files, leaves the outside folder, breaks Git status with exit 128, and writes no removal record. Only newly created disposable fixture data is removed. Retained fixture: `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-fleet-check-ghuzY1`. Replace deletion assertions with preservation assertions when repairing cleanup.

Required rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual final output:
```text
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2888.750583
```

Files edited: `atris/receipts/2026-10-14-fleet-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and the new evidence entry in `atris/team/architect/logs/2026-10-14.md`. Existing router, rendered task view, and earlier log edits are excluded from staging.
Commands run: mission status and goal lookup, Git status/log/remote lookup, task list/new/claim/note/ready, brain activation, targeted reads/searches, runtime audit, required rerun, brain compile, whitespace check, explicit staging, commit, and push. Brain activation returned exit 2 with a write plan; no generated policy files were written. Artifacts: extended audit, this decision card, navigation updates, member evidence, and retained disposable fixture.
Progress: one new dependency-loss case, eight audit cases overall, twelve required checks passed, zero production changes, zero dependencies, zero new filenames.
next_push: Preserve shared Git storage whenever a registered outside copy still depends on it, even with no current activity.
layer: beliefs

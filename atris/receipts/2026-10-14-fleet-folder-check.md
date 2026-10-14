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

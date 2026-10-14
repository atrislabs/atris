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

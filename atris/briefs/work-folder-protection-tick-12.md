Regression cleanup now preserves existing folders after failed creation, verified by 21 passing folder-protection and tidy checks, exit 0.

Files edited: commands/autopilot.js; test/worktree-removal-guard.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/briefs/work-folder-protection-tick-12.md. Member log appended: atris/team/architect/logs/2026-10-14.md. Task commands regenerated atris/TODO.md; that unrelated rendered replacement is excluded from the commit.

Decision: proceed with one ownership check. The failure mode was cleanup in finally force-removing an existing registered folder after git refused to create it. Cleanup now requires successful creation by this invocation, then uses the existing live-process check, git-activity check, and removal log. No policy, mission settings, or dependencies changed.

Plan: create -> owned -> activity checks -> remove and log; failed create -> leave existing folder alone.

Real-surface proof: the new tests invoke the actual regressionCheck routine with real git repositories and registered folders, without mocks. Both clean and dirty existing folders were deleted before repair. After repair, the folder, git registration, original commit, and unfinished file survive; the verify command does not run and no removal is logged. This routine runs inside autopilot, rather than having a separate CLI command.

Reproduction command:
node --test --test-name-pattern='keeps an existing' test/worktree-removal-guard.test.js
Before repair: exit 1. Actual output excerpt:
✖ autopilot regression check keeps an existing clean folder when creation fails
✖ autopilot regression check keeps an existing dirty folder when creation fails
AssertionError: the folder existed before this invocation
ℹ tests 2
ℹ pass 0
ℹ fail 2

Rerunnable frozen verification command:
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
After repair: exit 0. Actual output excerpt:
✔ autopilot regression check keeps an existing clean folder when creation fails (125.4335ms)
✔ autopilot regression check keeps an existing dirty folder when creation fails (119.956ms)
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ duration_ms 2898.568166

Progress: one ownership hole closed; two real-runtime regression cases added; 21/21 frozen checks pass. No second slice or full-suite claim.

State commands: atris mission status mission-2026-10-14-finish-work-folder-protectio-35ad161f; git status --short; atris brain activate --root . --verify; atris task list --status open; atris mission goal --json; atris task list --status doing; atris task list --status review; atris mission attach-task mission-2026-10-14-finish-work-folder-protectio-35ad161f --json; atris task new, claim, note, ready. Context read: member identity, protocol, navigation, prior receipts and log, actual cleanup code and tests. git log and git remote read for landing context. Brain activation returned plan-only exit 2 with missing generated files; task attachment returned lock-busy exit 3. Neither was overridden. Mission remains running under its existing owner.

Required proof gate: atris task ready reran the frozen command with --verify, exit 0; receipt atris/runs/2026-10-14-task-afw-2-2026-10-14T12-53-46-492Z.json. The first ready attempt rejected the plain result wording; the second required execution inside that process. Corrected wording and ran the required gate. Brain compile returned plan-only exit 2. git diff --check exited 0.

Landing: commit and push this safe internal repair; leave task proof in Review, without accepting or merging as the advisory member. Stop after this single verified slice.
next_push: prove that autopilot regression cleanup detects a real background process without an injected process list.
layer: behaviors

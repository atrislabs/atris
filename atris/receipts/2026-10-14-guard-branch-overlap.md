# Two work-folder guard branches overlap

Verdict: proceed-with-changes. Land one guard, then carry only the other branch's distinct parts onto it.

## What is on each side

- Pull request 1184 (`codex/architect-finish-work-folder-protection-across-20261014-113334`, head `a34aa48d`) adds its own lock helpers inside `commands/worktree.js` and uses them in reap, worktree cleanup, member tidy, green landing, autopilot's regression check, and fleet review cleanup. It names one lock per kept folder. It merges cleanly into master.
- This branch (`architect-help-output-not-cut-short`, 16 commits past master, no pull request) adds `lib/git-activity.js` and uses it in reap, worktree cleanup, member tidy, and autopilot's regression check. It lists every lock path and age. It does not guard fleet review cleanup, which is a protected surface. It also carries the fleet and autopilot cleanup audits under `atris/receipts/`.
- Master has neither guard.

## Proof

```text
$ git merge-tree --write-tree --name-only HEAD a34aa48d
CONFLICT (content): Merge conflict in atris/MAP.md
CONFLICT (content): Merge conflict in atris/refs/MAP-NOTES.md
CONFLICT (content): Merge conflict in atris/team/architect/logs/2026-10-14.md
CONFLICT (content): Merge conflict in commands/autopilot.js
CONFLICT (content): Merge conflict in commands/worktree.js
CONFLICT (content): Merge conflict in lib/member-tidy.js
CONFLICT (content): Merge conflict in test/worktree-removal-guard.test.js
exit 1

$ git merge-tree --write-tree --name-only origin/master a34aa48d
exit 0
```

## The one risk

Someone resolves the conflicts file by file and keeps both guards. Fleet cleanup would then use the pull request's helper, which names one lock, and reap would use this branch's helper, which names every lock. That leaves two definitions of "git is busy here" that can disagree, and every later fix would have to land twice.

## Safeguard

Merge pull request 1184 first, since it is the only side that covers fleet review cleanup and it merges clean. Then rebase this branch onto it and keep only three things: listing every lock instead of one, the cleanup audits, and the tests. Replace the pull request's single-lock lookups with that one helper in the same change. Do not merge this branch as it stands.

## Correction: 1184 misses a shared branch lock

Verdict changes from "merge 1184 first" to "merge 1184 only after it checks the shared Git storage too."

This branch's two required test files, run against 1184's code in a scratch copy, pass 7 of 13. Every folder holding its own lock is still kept, but only that lock is named; the shared branch lock beside it never appears. Two regression-cleanup tests fail on a different result shape, not on safety.

The probe holds only a two-hour-old shared branch lock and asks cleanup and reap, in preview, about a landed linked copy:

```text
$ node atris/receipts/2026-10-14-shared-lock-probe.js <1184 checkout>
{ "cleanup": "would remove", "reap": "would remove" }
exit 0

$ node atris/receipts/2026-10-14-shared-lock-probe.js .
cleanup: kept, git_activity, git locks: .../repo/.git/refs/heads/master.lock (7200s old)
reap: kept, git locks: .../repo/.git/refs/heads/master.lock (7200s old)
exit 0
```

Safeguard: before 1184 merges, swap its single-folder lock lookups for the helper that walks both the copy's own Git files and the shared ones, and bring this branch's lock tests with it. Then retire the rest of this branch.

## Fix ready on top of 1184

Branch `architect-1184-shared-lock-check` (commit `f1b29117`, parent `a34aa48d`) keeps 1184's helpers and makes its folder check also look for branch and packed-reference locks in the shared store. Only locks count there, so a merge paused in the main checkout does not hold linked folders.

- New test first failed (cleanup removed the folder), then passed.
- `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` on that branch: 33 of 33, exit 0. Neighboring cleanup, autoland, and green-landing tests: 99 of 99, exit 0.
- `node atris/receipts/2026-10-14-shared-lock-probe.js <that checkout>`: cleanup and reap both keep the folder, reap naming `.../refs/heads/master.lock, 2 h old`, exit 0.
- `atris worktree cleanup --base HEAD --apply --json` on a fixture with only a shared branch lock: kept, `git_lock`, the lock path, `lock_age_ms` 7201449, no removal record, exit 0.

## Every lock named

Same branch, commit `59952d00`. The lookup returns every lock with its age instead of the first one. Cleanup prints one line per lock, reap and tidy list them all, and fleet review joins the locks from its folder, its git store, and its quarantine. The first lock keeps the fields earlier readers use.

- New test with a 3 h own lock and a 5 h shared branch lock first failed (cleanup had no list), then passed.
- `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` on that branch: 34 of 34, exit 0. Neighboring cleanup, land, fleet, and tidy tests: 206 of 207. The one failure, sealed flights keeping parent owner names, also fails with this change set aside.
- `atris worktree cleanup --base HEAD --apply` on a fixture holding both locks: folder kept, two lines, `index.lock age=3 h` and `refs/heads/master.lock age=5 h`, exit 0. With the locks gone, the same command removed it, exit 0.

Take into 1184: commits `f1b29117` and `59952d00` on `architect-1184-shared-lock-check`.

## Owner-name test failure is not from 1184

The sealed flights owner-name test fails the same on master (`a8b9f17b`), on 1184 (`a34aa48d`), and on the fix branch (`59952d00`): 1 of 2, exit 1 each. Cause: the owner lookup reads `git config user.name` from the folder the test runs in, and this checkout sets a local name (`T`) that hides the temporary home name. Run from a folder outside any repo, the test passes 2 of 2, exit 0. It does not block 1184 taking the two fix commits. Decision card: `atris/status/for-you.md`.

## Combined-copy proof

The existing lock repair combines cleanly with fetched master. The real shared-lock probe kept the folder in both cleanup paths, and the required checks passed 34 of 34 in the combined copy, exit 0. This is targeted compatibility evidence, not a full-suite result or approval to land the protected implementation.

Inputs: master `a8b9f17b2ed955df4fdff1717cc6057aea7f480a`, repair `59952d00797f33c0feaca8f9b0a688e8ddb62bda`. Command: `git merge-tree --write-tree origin/master architect-1184-shared-lock-check`. Output: `554b49cbbd0b172b00470b4ab382987d26a83531`, exit 0, no conflicts. Exported that tree using `git archive --format=tar --output=/tmp/atris-lock-combined-VdTOH4/tree.tar 554b49cbbd0b172b00470b4ab382987d26a83531` and `tar -xf /tmp/atris-lock-combined-VdTOH4/tree.tar -C /tmp/atris-lock-combined-VdTOH4`, both exit 0. The disposable copy is retained; no checkout or branch was merged.

Runtime command: `node atris/receipts/2026-10-14-shared-lock-probe.js /tmp/atris-lock-combined-VdTOH4`, exit 0. Actual output:

```text
{
 "cleanup": "kept: git_lock",
 "reap": "kept: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/acw-shared-only-1pIEjC/engine-wt (git_lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/acw-shared-only-1pIEjC/repo/.git/refs/heads/master.lock, 2 h old)"
}
```

Rerunnable verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js` from `/tmp/atris-lock-combined-VdTOH4`, exit 0. Actual final output:

```text
ℹ tests 34
ℹ suites 0
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4059.221625
```

The same command in the current checkout passed 13 of 13, exit 0, duration 3068.39125 ms. No full suite ran in this increment. The combined archive has no Git registration, so later tests needing a checkout must use a disposable Git repository rather than assume this archive is one.

Files edited: this receipt and `atris/team/architect/logs/2026-10-14.md`. Task commands regenerated the rendered task view, which is excluded alongside the existing router edit. Commands also run: mission status/goal, task list/new/claim/note/ready, Git status/fetch/revision reads, brain activate/compile (plan only), whitespace check, explicit staging, commit, and push. Artifacts: combined disposable copy and this proof. Progress: one clean trial combination, two cleanup paths kept the locked folder, 34 combined checks and 13 current checks passed, zero production edits, zero new filenames or dependencies.
next_push: Run the full repair suite in a disposable Git checkout of the combined tree, with the local owner-name contamination removed.
layer: beliefs


## Full combined repair checks in a real Git copy

Recorded the full combined repair check result. Required folder checks pass, but the full run is not green: 5891 passed and 12 failed. This is proof of remaining blockers, not approval to land the protected implementation.

The previously combined tree `554b49cbbd0b172b00470b4ab382987d26a83531` was exported into `/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-suite-lp74sw3m`, initialized with `git init -q --initial-branch=master`, staged with `git add .`, and committed with `git -c user.name=proof -c user.email=proof@example.com commit -qm "combined repair proof"`. Each command exited 0. `git config --local --get user.name` exited 1 with no output, confirming the local owner-name override is absent. The original checkout and repair branch were not merged or changed.

Full command: `node --test > full-check.txt 2>&1`, from that copy, exit 1. This is the package's full test command, with output saved unchanged in `/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-suite-lp74sw3m/full-check.txt`. An initial `node --test test` invocation exited 1 because this Node version treated the directory as a module; it ran no suite. The corrected invocation completed:

```text
ℹ tests 5903
ℹ suites 22
ℹ pass 5891
ℹ fail 12
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 449271.733084
```

Exact failing locations:

```text
test at test/lesson-gate.test.js:113:3
test at test/lesson-gate.test.js:150:3
test at test/lesson-gate.test.js:180:3
test at test/map-notes-readers.test.js:115:1
test at test/map-refs-accurate.test.js:35:1
test at test/member-run-start.test.js:226:1
test at test/mission-run-reliability.test.js:156:1
test at test/mission-run-reliability.test.js:211:1
test at test/repo-hygiene.test.js:28:1
test at test/roster-markdown.test.js:486:1
test at test/roster-markdown.test.js:540:1
test at test/smoke.fast.test.js:52:1
```

One failure names `commands/worktree.js -> describeLocks` as an unused export. The map failures name a missing "if present" qualifier and a stale `commands/worktree.js:1230` reference. Three lesson checks invoke the installed Codex executable and fail its trusted-directory check. Other failures concern detached drivers, routing defaults, and the fast smoke engine list. No baseline comparison ran, so those failures are not attributed to the repair.

Real runtime command: `node atris/receipts/2026-10-14-shared-lock-probe.js /var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-lock-suite-lp74sw3m`, run from the current checkout, exit 0. Actual output:

```text
{
 "cleanup": "kept: git_lock",
 "reap": "kept: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/acw-shared-only-BxWCGx/engine-wt (git_lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/acw-shared-only-BxWCGx/repo/.git/refs/heads/master.lock, 2 h old)"
}
```

Rerunnable required command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`. In the combined Git copy, exit 0:

```text
ℹ tests 34
ℹ pass 34
ℹ fail 0
ℹ duration_ms 3426.526
```

In the current checkout, exit 0:

```text
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ duration_ms 3058.426708
```

Files edited: this receipt and `atris/team/architect/logs/2026-10-14.md`. Artifact: retained combined Git copy and its full raw output. Commands also run: Atris boot, mission status/goal, task list/new/claim/note/ready, Git status/config/object reads, brain activate/compile (plan only, exit 2), explicit staging, whitespace check, commit, and push. Existing router changes and the regenerated task view are excluded. Progress: one complete full-suite attempt, twelve exact failures recorded, 34 combined and 13 current required checks passing, two cleanup paths kept the locked folder, zero production edits or new repository filenames.
next_push: Remove the unused describeLocks export from the repair branch and prove its repository-hygiene check alongside the required folder checks.
layer: beliefs


## Unused lock description export removed

Removed only the unused public describeLocks entry from the existing repair copy; its internal definition and caller remain. Repository search found only the definition, internal call, and export before the change, so no external caller loses behavior. No new filenames, dependencies, folder-removal behavior, or protected landing.

Edited: `commands/worktree.js` in `/Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-1184-shared-lock-check`; this receipt; `atris/team/architect/logs/2026-10-14.md`.

Actual CLI command in the repair copy: `node bin/atris.js slop dead --exports`, exit 0. Output: `✓ no dead code, all 362 files reachable from the entrypoints`.

Rerunnable repair proof: `node --test test/repo-hygiene.test.js test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0. Exact summary: tests 37, pass 37, fail 0, cancelled 0, skipped 0, todo 0. The export-hygiene assertion passed. Required command in the current checkout: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0; tests 13, pass 13, fail 0, cancelled 0, skipped 0, todo 0. No full-suite rerun or claim of full-suite green.

Other commands: Atris boot, brain activate/compile (plan only, exit 2), mission status/goal, task list/new/claim/note/ready, Git status/diff/log/worktree/branch/remote reads, rg caller search, explicit staging, commit and push. Existing router and rendered task-view edits are excluded.

Progress: one orphaned export removed; all 37 repair checks and 13 current checks pass; no production behavior changed.
next_push: Compare the remaining combined-suite failures with master to separate existing failures from repair regressions.
layer: capabilities

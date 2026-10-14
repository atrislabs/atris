# Regression folder cleanup

Automatic cleanup now preserves folders with Git activity and records successful removals. The required tests and a real cleanup invocation both exited 0.

Plan: created folder -> running program and Git lock checks -> keep with reason or remove and log.

Changed files: `commands/autopilot.js`, `test/worktree-removal-guard.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`, and this receipt with its matching JavaScript proof.

Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Output excerpt, exit 0:
```text
tests 12
pass 12
fail 0
cancelled 0
skipped 0
todo 0
```

Real surface: `node atris/receipts/2026-10-14-autopilot-folder-check.js`, exit 0. This calls the production regression routine directly, creates real Git copies, runs real check commands, and retains its locked fixture for inspection. It avoids starting the unrelated full automatic build loop.

Output excerpt:
```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi
removal recorded: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi/.atris/state/worktree_removals.jsonl
  kept /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi/.regression-worktree-7e7393ed: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-regression-check-jfGlLi/.git/worktrees/-regression-worktree-7e7393ed/index.lock (7200s old)
clean folder removed and logged; locked folder retained with its exact lock path and age
```

Progress: one remaining removal path guarded; two added real-runtime tests cover old private/shared locks, successful logging, and failed creation of an already-existing folder. No dependencies or protected filename words added. A first test run exposed a circular import; loading the shared removal helpers when the routine runs fixed it.

Other commands: mission status, task list/new/claim/note/ready, Git status/diff, and the brain activation/compile commands. Brain commands exited 2 with a preview of unrelated generated files; those files were not changed. Existing edits to `bin/atris.js` and `atris/TODO.md` remain outside this change.

Save-check lesson: the proof now runs only when called directly and clears inherited Git environment settings before creating its fixture. Its initial load altered the checkout index; the index was restored from unchanged HEAD and only the declared files were staged. The save check passed without overrides. The change was committed and pushed, with task proof ready for review.

next_push: Protect fleet cleanup with the shared Git-activity check and removal log.

layer: behaviors

## Late keep marker during the safety check

Regression cleanup now has proof that a folder is kept when Git's keep marker appears while cleanup runs its one safety check. The proof and the required tests both exited 0.

How it works: the proof makes a fresh commit, puts a forwarding git first on the path, and adds an aged keep marker the moment cleanup asks Git about the folder. Cleanup keeps the folder, its files and the marker, names the marker path and its age, and never tries to remove it. The removal log still holds only the earlier clean removal.

Real surface: `node atris/receipts/2026-10-14-autopilot-folder-check.js`, exit 0.

```text
  kept .../.regression-worktree-fcae3c20: git locks: .../.git/worktrees/-regression-worktree-fcae3c20/locked (10799s old)
late keep marker during the safety check kept the folder, named the marker and its age, and no removal was attempted
```

Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0, 22 passed, 0 failed.

Learned: cleanup reads its clock before the marker lands, so a marker aged exactly two hours reports one second less. The proof ages the marker three hours and accepts a ten second window.

next_push: Prove a late ordinary private and shared lock during the regression cleanup's safety check keeps the folder and names both lock paths with distinct ages.

layer: behaviors

## Late ordinary locks during the safety check

Regression cleanup now has proof that a folder is kept when ordinary Git locks appear while cleanup runs its safety check. One lock sits in the folder's own Git files, aged three hours, and one sits in the shared Git files, aged four hours.

Cleanup keeps the folder, its files and both locks, names both lock paths with their own ages, and never tries to remove it. The removal log still holds only the earlier clean removal.

Real surface: `node atris/receipts/2026-10-14-autopilot-folder-check.js`, exit 0.

```text
  kept .../.regression-worktree-5da2e599: git locks: .../.git/packed-refs.lock (14399s old), .../.git/worktrees/-regression-worktree-5da2e599/index.lock (10799s old)
late private and shared locks during the safety check kept the folder, named both paths with distinct ages, and no removal was attempted
```

next_push: Prove a folder that disappears during the regression cleanup's safety check is reported as missing, names any retained lock and its age, and attempts no removal.

layer: behaviors

## Folder disappearing during the safety check

Regression cleanup now says a folder is missing when it disappears during the safety check, and names the locks it left behind with their ages. Before, it named the locks as if the folder were still there.

The proof moves the folder away the moment cleanup asks Git about it, after adding a private lock aged three hours and a shared lock aged four hours. Cleanup keeps everything, reports the folder as missing with both lock paths and ages, and never tries to remove it. The same proof fails against the previous code.

Real surface: `node atris/receipts/2026-10-14-autopilot-folder-check.js`, exit 0.

```text
  kept .../.regression-worktree-457a14c1: folder is missing; git lock: .../.git/packed-refs.lock (14400s old), .../.git/worktrees/-regression-worktree-457a14c1/index.lock (10800s old)
a folder that disappeared during the safety check was reported missing with both retained lock paths and ages, and no removal was attempted
```

next_push: Prove regression cleanup says only that the folder is missing, naming no lock, when a folder disappears mid-check and no lock remains.

layer: behaviors

## Folder disappearing with no lock left

Regression cleanup now has proof that a folder disappearing during the safety check with no lock behind it is reported only as missing. No lock is named, and no removal is attempted.

This case runs first so no shared lock from a later case can leak into it. The forwarding git now runs the real check from the original folder path, so the check fails the way it would when a folder is truly gone.

Real surface: `node atris/receipts/2026-10-14-autopilot-folder-check.js`, exit 0.

```text
  kept .../.regression-worktree-3e2b5fcf: folder is missing
a folder that disappeared during the safety check with no lock left was reported only as missing, and no removal was attempted
```

next_push: Prove regression cleanup keeps a folder that disappears after a passing safety check but before removal, records no removal, and gives a plain reason.

layer: behaviors

## Folder disappearing after a passing safety check

Regression cleanup now looks on disk right before removing a folder. Git's removal exits 0 even when the folder is already gone, and quietly drops Git's record of it.

Before this change, a folder moved after a passing check was logged as removed. The moved copy also lost its link to Git. The proof moves the folder right after the check passes, and the previous code failed it:

```text
{"slug":"late-after","pass":true,"cleanup":{"path":".../.regression-worktree-0102e170","removed":true}}
AssertionError [ERR_ASSERTION]: fatal: not a git repository: .../.git/worktrees/-regression-worktree-0102e170
```

Now cleanup reports the folder as missing, Git still lists it, no removal is attempted, and the removal log gains no line.

Real surface: `node atris/receipts/2026-10-14-autopilot-folder-check.js`, exit 0.

```text
  kept .../.regression-worktree-287f9215: folder is missing
a folder that disappeared after a passing safety check was reported missing, kept in Git, and no removal was attempted or recorded
```

next_push: Prove and close the same gap in old-folder cleanup, whose code hands a folder that passed its check straight to Git's removal without looking on disk.

layer: behaviors

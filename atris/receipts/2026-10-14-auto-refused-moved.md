# Automatic cleanup names locks when a refused folder moves

When automatic regression cleanup asked Git to remove its work folder and Git refused, a folder that moved at the same moment was reported with Git's error only. The lock files that made Git refuse went unnamed.

Now the cleanup looks on disk after a refusal. If the folder is gone, it says the folder is missing and names each lock file with its age, the same way member tidy does.

## Proof

Before the fix, the new moved case in the real cleanup routine:

```
node atris/receipts/2026-10-14-autopilot-folder-check.js
"reason":"fatal: cannot remove a locked working tree, lock reason: held during cleanup ..."
AssertionError [ERR_ASSERTION]
exit 1
```

After the fix:

```
node atris/receipts/2026-10-14-autopilot-folder-check.js
"reason":"folder is missing; git lock: .../.git/packed-refs.lock (14400s old), .../.git/worktrees/-regression-worktree-490cc3d7/index.lock (10800s old), .../.git/worktrees/-regression-worktree-490cc3d7/locked (7200s old)"
a folder that moved while Git refused removal was reported missing with three locks and distinct ages; files and Git record retained; no removal recorded
exit 0
```

Required checks:

```
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
tests 30, pass 30, fail 0, exit 0
```

## Files

- commands/autopilot.js: refusal path checks the disk and uses the missing-folder lock scan
- atris/receipts/2026-10-14-autopilot-folder-check.js: seventh timing case, folder moves while Git refuses
- test/worktree-removal-guard.test.js: pins the new proof line
- atris/refs/MAP-NOTES.md: refreshed refs

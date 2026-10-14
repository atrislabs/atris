# Worktree cleanup names locks when Git refuses removal

When Git refused to remove a merged copy after every cleanup check passed, worktree cleanup kept the copy but printed nothing about it beyond the kept count. The lock files that made Git refuse went unnamed, and a copy that moved during the refusal was not reported as missing.

Now cleanup prints a line for that copy with Git's first error line, then each lock file still holding it and its age. If the copy moved, it says the folder is missing and still names the locks. It uses the same shared check as member tidy and automatic cleanup.

## Proof

Before the fix, real CLI, Git refuses after the checks pass:

```
node atris/receipts/2026-10-14-worktree-cleanup-refused-check.js
case: refused
removeds: 0
kept: 2
cli exit: 0
AssertionError
exit 1
```

After the fix:

```
node atris/receipts/2026-10-14-worktree-cleanup-refused-check.js
case: refused
kept: .../merged-copy reason=remove_failed git refused: fatal: cannot remove a locked working tree, lock reason: held during cleanup; git locks: .../repo/.git/packed-refs.lock (14400s old), .../repo/.git/worktrees/merged-copy/index.lock (10800s old), .../repo/.git/worktrees/merged-copy/locked (7200s old)
cli exit: 0
case: refused-moved
kept: .../merged-copy reason=remove_failed git refused: fatal: cannot remove a locked working tree, lock reason: held during cleanup; folder is missing; git lock: .../repo/.git/packed-refs.lock (14400s old), ...
cli exit: 0
Git refusal named three locks and distinct ages, in place and after the copy moved; files, branch, locks, and Git record retained; no removal recorded
exit 0
```

Required checks:

```
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
tests 32, pass 32, fail 0, exit 0
```

## Files

- commands/worktree.js: both refusal paths use the shared check; the kept list prints refused copies
- atris/receipts/2026-10-14-worktree-cleanup-refused-check.js: real CLI timing proof, two cases
- test/worktree-removal-guard.test.js: reruns the proof
- atris/refs/MAP-NOTES.md: new ref, two stale refs corrected

# Tidy names locks when a refused folder moves

Cleanup kept a landed copy after Git refused removal and the folder moved at the same moment. Before this change, tidy printed only the Git error. It now also says the folder is missing and names each lock file with its age.

## Before (real CLI, eighth timing case, old code)

```
kept  landed-copy  landed, but git refused: fatal: cannot remove a locked working tree, lock reason: drive moved during cleanup
audit exit: 1
```

## After

```
$ node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js
kept  landed-copy  landed, but git refused: fatal: cannot remove a locked working tree, lock reason: drive moved during cleanup; folder is missing; git lock: <fixture>/refused-moved/repo/.git/packed-refs.lock (14398s old), <fixture>/refused-moved/repo/.git/worktrees/landed-copy/index.lock (10798s old), <fixture>/refused-moved/repo/.git/worktrees/landed-copy/locked (7198s old)
tidy: removed 0, kept 1, of 1 copy in <fixture>/refused-moved/copies
cli exit: 0
missing folder reported: true
retained locks reported: true
retained lock: <fixture>/refused-moved/repo/.git/worktrees/landed-copy/locked (7200s old)
retained lock: <fixture>/refused-moved/repo/.git/worktrees/landed-copy/index.lock (10800s old)
retained lock: <fixture>/refused-moved/repo/.git/packed-refs.lock (14400s old)
all eight timing cases passed; Git refusal after a passing check named three locks and distinct ages, also when the folder moved; files, locks, branches, and Git records retained; no removal recorded
audit exit: 0

$ node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
tests 30, pass 30, fail 0
verifier exit: 0
```

Files, all three locks, the branch, and the Git registration survived. No removal was recorded.

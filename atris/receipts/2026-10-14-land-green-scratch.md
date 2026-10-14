# Green landing keeps a scratch copy that still holds Git locks

Green landing checks a stale branch in a temporary scratch copy, then tears that copy down. The teardown force-removed the copy, deleted the folder from disk whatever Git said, and then pruned every missing copy's record across the repository. It checked no locks and wrote nothing to the removal log.

Now the teardown checks first. A scratch copy holding Git locks is kept, and each lock file is named with its age. A copy that moved is reported as missing with its locks, and its Git record stays. A clean copy is removed and logged like every other cleanup. The repository-wide prune is gone, so this teardown can no longer drop the record of some other copy that happened to be moved.

Cost: a kept scratch copy stays in the temporary folder until someone clears the lock and runs cleanup.

## Proof

Before the fix, real routine with real Git:

```
node atris/receipts/2026-10-14-land-green-scratch-check.js
case: clean
verdict: member/work red
AssertionError: clean scratch removal was not logged
exit 1
```

After the fix:

```
node atris/receipts/2026-10-14-land-green-scratch-check.js
case: clean
removal recorded: {"path":".../atris-land-green-iGf66t","by":"atris land green","reason":"scratch_check_finished",...}
case: locked
stderr: land green: kept scratch copy .../atris-land-green-Se7Ybt: git locks: .../locked/.git/packed-refs.lock (14400s old), .../locked/.git/worktrees/atris-land-green-Se7Ybt/index.lock (10800s old)
case: moved
stderr: land green: kept scratch copy .../atris-land-green-13NgH1: folder is missing; git lock: .../moved/.git/packed-refs.lock (14400s old), .../moved/.git/worktrees/atris-land-green-13NgH1/index.lock (10800s old)
exit 0
```

Required checks and green landing tests:

```
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
tests 33, pass 33, fail 0, exit 0
node --test test/land-green.test.js
tests 12, pass 12, fail 0, exit 0, no scratch copy kept
```

## Files

- lib/land-green.js: guarded teardown, resolved scratch path, no repo-wide prune
- atris/receipts/2026-10-14-land-green-scratch-check.js: three-case proof
- test/worktree-removal-guard.test.js: reruns the proof
- atris/refs/MAP-NOTES.md: new ref

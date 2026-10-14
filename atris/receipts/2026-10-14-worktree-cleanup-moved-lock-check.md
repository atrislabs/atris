# Worktree cleanup names a leftover lock for a moved copy

A copy can move after its checks pass and leave a shared Git lock behind. The worktree cleanup command now has a real-command proof that it keeps that copy as missing and names the exact lock file and its age.

On the code from before the moved-copy fix, `node atris/receipts/2026-10-14-worktree-cleanup-moved-lock-check.js` exited 1:

```text
removeds: 1
removed: .../merged-copy branch=merged-copy reason=merged_into_base
AssertionError [ERR_ASSERTION]
```

On current code the same proof exits 0:

```text
removeds: 0
kept: .../merged-copy reason=missing folder is missing; git lock: .../repo/.git/refs/heads/merged-copy.lock (91s old)
a copy moved after its final checks passed was kept as missing with the leftover shared lock and its age named; lock, files, branch, and Git record retained; no removal attempted or recorded
```

Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0, 24 passed, 0 failed.

next_push: Prove land's reap keeps a folder moved after its final check passes and names a leftover shared lock with its age, using the real land command.

layer: behaviors

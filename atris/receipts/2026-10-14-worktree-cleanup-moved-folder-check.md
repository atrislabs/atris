# Worktree cleanup and a copy moved after its checks pass

The worktree cleanup command now looks on disk right before choosing a copy for removal. Git's removal exits 0 for a folder that is already gone, so the real command used to report a moved copy as removed. It also dropped Git's record of the copy, cutting it off from its branch.

Before the fix, `node atris/receipts/2026-10-14-worktree-cleanup-moved-folder-check.js` exited 1 on the real command:

```text
command: node bin/atris.js worktree cleanup --apply --base master
removeds: 1
removed: .../merged-copy branch=merged-copy reason=merged_into_base
AssertionError [ERR_ASSERTION]
```

After the fix, the same proof exits 0:

```text
removeds: 0
kept: .../merged-copy reason=missing folder is missing
a copy moved after its final checks passed was kept as missing; files, branch, and Git record retained; no removal attempted or recorded
```

Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0, 23 passed, 0 failed. The three other worktree cleanup test files also pass, 12 of 12.

next_push: Prove worktree cleanup names a retained lock and its age when a copy moved after its checks pass leaves a shared lock behind.

layer: behaviors

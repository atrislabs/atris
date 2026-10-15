# Reference lock guard for sandbox disposal

Sandbox disposal now keeps every folder while Git is updating a branch or the
packed reference list in either separate store. The four deletion gaps measured
by the previous review are closed.

Change: the git-activity guard treats packed-refs.lock and any lock under refs/
at any depth as a held lock. Every caller of the store check inherits this,
including linked work folders, which only gain locks from their own private refs.

## Real surface proof

Command: `node atris/receipts/work-folder-quarantine-probe.js --require-protection`
Exit: 0 (was 1 with four gaps).

```text
quarantine unlocked: removed true, all folders kept false, removal logged true
objects packed-refs.lock: removed false, all folders kept true, removal logged false
objects refs/heads/review.lock: removed false, all folders kept true, removal logged false
quarantine packed-refs.lock: removed false, all folders kept true, removal logged false
quarantine refs/heads/review.lock: removed false, all folders kept true, removal logged false
review gaps: 0; only disposable fixture repositories touched
```

Regression: a new test covers both stores with both lock kinds and asserts the
whole sandbox stays and no removal line is written. With the guard change
reverted, that test fails (exit 1); with it, the frozen check passes.

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0, tests 28, pass 28, fail 0.

Limit: lock files are modeled, not a live writer. A stale lock left by a
crashed Git now keeps the sandbox until someone clears it, same as index.lock.

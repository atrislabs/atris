# Locked quarantine cleanup review

Saved a runnable review proving that sandbox disposal removes a locked quarantine Git store. The real disposal probe exited 0 in reporting mode; the frozen behavior tests exited 0, 23 passed and 0 failed. This is advisory evidence, not a runtime repair.

## Verdict

Proceed with changes to the cleanup plan. One risk: checking only the working folder's Git metadata allows cleanup to delete a separate store with a write lock. Before building, require a real-Git regression that places HEAD.lock in quarantine and keeps the entire sandbox with no removal record. Check every Git store that disposal will delete before the first removal; checking only after removing the working folder would leave partial destruction.

Flow: fresh temporary repositories -> quarantine lock marker -> actual disposeReviewSandbox -> observed removal.

A marker reproduces the guard contract without racing a live writer. This does not establish that a real writer was interrupted. No existing project data or runtime implementation changed.

## Real surface proof

Command: `node atris/receipts/work-folder-quarantine-probe.js`

Actual output, exit 0:

```text
unlocked quarantine: removed true, store kept false, removal logged true
locked quarantine: removed true, store kept false, removal logged true
review gaps: 1; only disposable fixture repositories touched
```

Command: `node atris/receipts/work-folder-quarantine-probe.js --require-protection`

Same output, exit 1 as expected. After repair, this command must exit 0. The unlocked control requires successful cleanup and logging; the locked case requires retention without a removal record.

Rerunnable frozen verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Actual output excerpt, exit 0:

```text
✔ fleet review cleanup keeps a sandbox while git holds its lock (78.037459ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2840.245625
```

## Scope and progress

Files edited: `atris/receipts/work-folder-quarantine-probe.js`, `atris/receipts/work-folder-quarantine-review-2026-10-14.md`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and the ignored local member log `atris/team/architect/logs/2026-10-14.md`. Existing rendered task changes remain unstaged.

Commands run: mission status and goal, git status/log/remotes, Atris boot, task list/new/claim/note/ready, source reads, brain activation and compile previews, both probe modes, frozen verification, git diff check, scoped commit and push. Brain activation preview exited 2 without writing files.

Metric: one newly reproduced real-runtime gap, one unlocked control, 23 required tests passing. Runtime protection is unchanged.

next_push: guard every sandbox Git store before disposal and add a real-Git quarantine-lock regression requiring full retention and no removal record.

layer: beliefs

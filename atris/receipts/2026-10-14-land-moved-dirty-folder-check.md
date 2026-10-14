# Land names a dirty folder that moves during its backup

Land cleanup now looks on disk before backing up a dirty folder. If the folder moved while the backup bundle was built, the backup failed on the missing folder and the receipt said only "salvage incomplete". The folder was kept, but the reason hid that it was gone and which lock it left.

On the old code, `node atris/receipts/2026-10-14-land-moved-dirty-folder-check.js` exited 1 on the real command:

```text
command: node bin/atris.js land --reap --force --no-remote
  kept, needs a human: .../dirty-copy (salvage incomplete: patch/copy failed, kept to avoid losing work)
cli exit: 0
AssertionError [ERR_ASSERTION]
```

After the fix, the same proof exits 0:

```text
  kept, needs a human: .../dirty-copy (folder is missing; git lock: .../repo/.git/refs/heads/dirty-copy.lock (93s old))
a dirty copy moved while its backup was built was kept as missing with the leftover shared lock and its age named; edits, lock, branch, and Git record retained; no removal attempted or recorded
```

Verify: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0, 25 passed, 0 failed. The land, landing reasons and land green test files also pass, 37 of 37.

next_push: Prove autopilot's regression cleanup names the folder as missing, not a failed check, when its folder moves before the final git check runs.

layer: behaviors

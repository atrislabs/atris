# Missing locked folders stay visible in cleanup

Cleanup now says a locked folder is missing and names its retained Git lock and age. Verified with the real cleanup command in preview and forced mode, then the frozen behavior checks.

## Files

- commands/land.js: completed the interrupted missing-folder check and preview reporting.
- test/worktree-removal-guard.test.js: one real Git regression covering both preview and forced removal.
- atris/receipts/2026-10-14-land-missing-folder-check.js: repeatable actual CLI proof with a generated fixture.
- atris/MAP.md and atris/refs/MAP-NOTES.md: missing-folder route and current references.
- atris/team/architect/logs/2026-10-14.md: proof and next move.
- atris/receipts/2026-10-14-land-missing-folder-check.md: this receipt.

## Proof

Command: `node atris/receipts/2026-10-14-land-missing-folder-check.js`
Exit: 0.
Fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-missing-6w0F78

Actual commands executed from the fixture repository:

```text
node bin/atris.js land --reap --force --no-remote --dry-run
landing cleanup preview: would clear 0 pieces of work, 0 side copies:
  kept, left alone: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-missing-6w0F78/landed-with-lock (folder is missing; git lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-missing-6w0F78/repo/.git/worktrees/landed-with-lock/locked (7200s old))
cli exit: 0
node bin/atris.js land --reap --force --no-remote
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-missing-6w0F78/landed-with-lock (folder is missing; git lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-missing-6w0F78/repo/.git/worktrees/landed-with-lock/locked (7200s old))
cli exit: 0
missing folder reported; lock and branch retained; no removal recorded
```

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0.

```text
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4269.102917
```

`git diff --check` also exited 0 before verification.

## Progress and boundary

One interrupted behavior fix proved, one added regression, two real CLI modes passed, zero lock or branch removals, zero removal-log entries. No dependency or protected file names added. The unrelated CLI help edit and rendered task changes were left out of the commit. Mission attachment refused because the running mission holds its lock; used a separate claimed proof task without changing mission settings.

next_push: Report missing folders that disappear between cleanup planning and the final removal check, including retained lock paths and ages.

layer: behaviors

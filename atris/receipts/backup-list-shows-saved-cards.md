# Backup list shows saved cards

What changed: the removal log now keeps the saved cards file and its fingerprint, and the backup list shows it. A folder that held only cards, with no other unsaved work, now appears in the list too. When the saved cards file is later removed or edited, the list says so instead of pointing at it.

Red check: the extended test run on the previous code.
```
no saved backups yet: no removal has recorded a restore command.
pass 0, fail 1
```

Real commands on a disposable repository, new code:
```
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (card filed in the folder)
  cards not in your inbox saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.for-you.md (1)
exit: 0
command: node bin/atris.js land --backups (saved cards)
saved backups: 1 removed folder held unsaved work, newest first
    cards saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.for-you.md (1)
exit: 0
command: node bin/atris.js land --backups (saved cards file removed)
saved backups: 1 removed folder held unsaved work, newest first
    saved cards file is missing: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.for-you.md
```
An edited cards file reads "saved cards file is changed", and the machine-readable list carries the same path and count with no restore.

Current increment: persisted card path, count and fingerprint in the removal log; exposed card-only saves in plain and JSON backup listings; checked intact, changed and missing saved cards with real CLI invocations in a disposable repository.

Files edited: commands/land.js, commands/worktree.js, test/worktree-removal-guard.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, this receipt, and the architect member log.

Initial full check failed because an update notification changed the last output line expected by existing tidy tests. The first run also exposed the missing removal-log field, now added. The repeated check disables the optional update notifier through its existing environment setting.

Rerun:
```sh
export ATRIS_SKIP_UPDATE_CHECK=1
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js && node bin/atris.js slop --staged
```

next_push: Add a way to read a saved card directly from the backup list.
layer: capabilities

Final check: pass 99, fail 0, skipped 0, todo 0; exit 0. Staged slop check: clean, no slop tells in 6 files; exit 0. Full output: /tmp/atris-card-check.log.

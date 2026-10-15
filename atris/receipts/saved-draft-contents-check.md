# Saved draft contents check

What changed: put-away now records a content fingerprint for each new file it saves. The backup list withholds the restore command when a saved draft inside a still-present backup folder was deleted or changed, and names the file.

Red check: the extended test run against the previous commit in a throwaway checkout.
old-code exit=1, pass 0, fail 2 (the list still offered a restore after the saved draft was damaged)

Test excerpt (disposable repository):
```
command: node bin/atris.js land --backups (damaged saved draft)
saved backups: 1 removed folder held unsaved work, newest first
  2026-10-15 19:52  <tmp>/engine-wt (engine-run)
    cannot restore: saved draft file is missing or changed: notes/draft.txt
exit: 0
command: node bin/atris.js land --backups (damaged saved draft)
saved backups: 1 removed folder held unsaved work, newest first
  2026-10-15 19:52  <tmp>/engine-wt (engine-run)
    cannot restore: saved draft file is missing or changed: notes/draft.txt
```

Real command on this repo:
```
$ node bin/atris.js land --backups
no saved backups yet: no removal has recorded a restore command.
exit=0
```

Restore tests, plain and quoted folder names: node --test --test-name-pattern="restores it exactly" test/worktree-removal-guard.test.js
ℹ pass 2
ℹ fail 0
exit=0

Frozen verifier on the staged slice: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js && node bin/atris.js slop --staged
tests 92, pass 92, fail 0, skipped 0, todo 0
clean, no slop tells in 6 files
exit=0

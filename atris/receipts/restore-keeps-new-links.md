# Restore keeps new links

What changed: put-away now saves a new link in a folder as a link, fingerprinted by where it points, and the restore gives it back as a link. Before this, the copy followed the link: a link to a file was saved as a plain copy, and a link to a folder or to nothing failed the copy, so the whole folder was kept for a human.

Red check: the new test run on the previous code.
```
kept, needs a human: <tmp>/engine-wt (salvage incomplete: patch/copy failed, kept to avoid losing work)
pass 0, fail 1
```

Real put-away command on a disposable repository with a link to a file, a link to a folder and a link to nothing, new code:
```
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (new links)
landing cleanup done: 1 pieces cleared, 1 side copies removed
  files saved as they were: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.untracked
exit: 0
command: node bin/atris.js land --backups (saved link pointed elsewhere)
    cannot restore: saved draft file is missing or changed: to-file
exit: 0
```
With the saved link put back, the printed restore rebuilt the same status with all three links pointing where they did.

Wider put-away, auto-land and green landing tests: node --test test/land.test.js test/autoland.test.js test/land-green.test.js
pass 106, fail 0, exit=0

Frozen verifier: tests 98, pass 98, fail 0, todo 0; clean, no slop tells in 5 files; exit=0

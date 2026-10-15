# Restore keeps trailing spaces

What changed: the saved patch check and the printed restore both turn whitespace checks off. A strict whitespace setting no longer keeps a folder for a human, and a fixing setting no longer strips trailing spaces when the folder is rebuilt.

Real cause probed first, in a scratch repository with the fixing setting:
```
fix check: 0 (the patch check passes, so the folder would be removed)
restored line bytes: a \n (the two trailing spaces were stripped)
same apply with whitespace checks off: a, two spaces, \n
```

Red check: the new tests run against the previous code (land.js set aside).
pass 1, fail 2. Under the fixing setting the old restore rebuilt the edited line without its trailing spaces:
```
+ '# fixture\nunsaved line\n'
- '# fixture\nunsaved line  \n'
```
Under the strict setting the old code kept the folder instead of putting it away.

The keep path, for a patch that would not apply, is now covered by a stand-in git that refuses the check, since no known setting makes a plainly saved patch fail it anymore.

Real put-away command on a disposable repository, new code, followed by running the printed restore in the test:
```
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (fix whitespace setting)
landing cleanup done: 1 pieces cleared, 1 side copies removed
  unsaved edits saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.dirty.patch
  staged changes saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.staged.patch
exit: 0
```
The restore rebuilt the same status, with trailing spaces kept in both the unsaved and the staged file.

Wider put-away, auto-land and green landing tests: node --test test/land.test.js test/autoland.test.js test/land-green.test.js
pass 106, fail 0, exit=0

Frozen verifier: tests 96, pass 96, fail 0, todo 0; clean, no slop tells in 5 files; exit=0

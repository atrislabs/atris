# Saved patches use plain settings

What changed: put-away now saves its patches with plain settings, whatever the folder's diff settings say: no text conversion, no outside diff program, no color, and the usual a/ b/ name prefixes. Folders under those settings used to be kept for a human; now they are put away with a restore command that works.

Real cause probed first: with a no-prefix setting, the saved patch cannot be applied at all.
```
noprefix apply: 128 (git diff header lacks filename information)
```

A strict whitespace setting still makes a patch refuse to apply. That keep path now has its own test with that real cause, replacing the text conversion one this change fixes.

Red check: the new put-away test run against the previous code (land.js set aside).
pass 1, fail 1; the failing test is the one with all four settings.

Real put-away command on a disposable repository, new code, followed by running the printed restore in the test:
```
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (spoiling diff settings)
landing cleanup done: 1 pieces cleared, 1 side copies removed
  unsaved edits saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.dirty.patch
  staged changes saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.staged.patch
exit: 0
```
The restore rebuilt the folder with the same status, the unsaved line, and the staged file.

Wider put-away, auto-land and green landing tests: node --test test/land.test.js test/autoland.test.js test/land-green.test.js
pass 106, fail 0, exit=0

Frozen verifier: tests 94, pass 94, fail 0, todo 0; clean, no slop tells in 5 files; exit=0

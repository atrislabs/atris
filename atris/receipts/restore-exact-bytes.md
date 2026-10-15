# Restore gives back exact bytes

What changed: put-away now also copies each edited tracked file as it was into the saved files folder, and the restore lays those copies down last. Applying a patch writes files the way a checkout would, so line ending and version tag settings used to change the restored bytes. The saved files line now reads "files saved as they were", since the folder holds more than new files.

Probe first: last tick guessed that a line ending setting could pass the patch check and then fail the restore. A sweep of eight setups in scratch repositories disproved it, since every restore applied. It found a different loss: the restored bytes differed in five setups.
```
autocrlf=input, CRLF in the commit:  restore=0 bytes-same=no
eol=crlf attribute, mixed edit:      restore=0 bytes-same=no
autocrlf=true, mixed edit:           restore=0 bytes-same=no
ident attribute:                     restore=0 bytes-same=no (version tag filled in)
```

Red check: the new test run against the previous code (land.js set aside).
pass 0, fail 1. The old restore gave back 25 bytes for a 24 byte file, an added carriage return.

Real put-away command on a disposable repository, new code, followed by running the printed restore in the test:
```
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (line ending and version tag settings)
landing cleanup done: 1 pieces cleared, 1 side copies removed
  unsaved edits saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.dirty.patch
  staged changes saved: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.staged.patch
  files saved as they were: <tmp>/repo/.atris/salvage/2026-10-15/engine-wt.untracked
exit: 0
```
The restore rebuilt the same status, the mixed line endings byte for byte, and the unfilled version tag.

Wider put-away, auto-land and green landing tests: node --test test/land.test.js test/autoland.test.js test/land-green.test.js
pass 106, fail 0, exit=0

Frozen verifier: tests 97, pass 97, fail 0, todo 0; clean, no slop tells in 5 files; exit=0

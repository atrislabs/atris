# Saved patches tried before removal

What changed: before put-away removes a folder with unsaved work, it tries each saved patch against the folder's commit in a throwaway index. If a patch would not apply, the folder is kept and the kept line says why.

Real cause found first: with a text conversion diff setting, git saves the converted text. Probe in a scratch repository:
```
diff saved with the setting: apply-check=1 (patch does not apply)
same edit saved without it:  apply-check=0
```

Red check: the new test run against the previous commit in a throwaway checkout.
old-code exit=1, pass 0, fail 1. The old put-away printed: landing cleanup done: 1 pieces cleared, 1 side copies removed, followed by a restore command for the removed folder that cannot work.

Real put-away command on a disposable repository, new code:
```
command: node bin/atris.js land --reap --no-remote --base master --ttl 0 (text conversion setting)
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: <tmp>/engine-wt (salvage incomplete: saved edits would not apply to the folder's commit, kept to avoid losing work)
  still flying (recent work, left alone): 0
exit: 0
```

On this repo a preview cannot reach the check, since previews back nothing up, and a real put-away here would remove 76 folders, so it was not run.

Wider put-away, auto-land and green landing tests: node --test test/land.test.js test/autoland.test.js test/land-green.test.js
pass 106, fail 0, exit=0

Frozen verifier on the staged slice: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js && node bin/atris.js slop --staged
tests 93, pass 93, fail 0, todo 0; clean, no slop tells in 6 files
exit=0

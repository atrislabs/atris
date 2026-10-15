# Removal scan catches shell folder deletes

The scan that fails unprotected folder deletes now also recognizes a shell `rm -r`, whether typed into a command string or passed to spawn as arguments. Before, new cleanup code could delete a work folder through the shell with no git check and no log, and every test stayed green.

## Verdict on the planned next step

Dropped. The last tick proposed a reap test with a lock in the shared Git store. Reap removes folders only through git worktree remove, which deletes the work folder and its small entry in the shared store, never the store itself. A commit in progress already holds a lock in the folder's own Git data, which reap checks, and a branch delete that meets a lock fails and is reported. The test would have guarded nothing.

## Coverage sweep

Searched lib and commands for every way a folder tree could be deleted outside the scan's view:

- Shell recursive deletes: only help-text examples in the remote terminal command. Now covered by the scan anyway.
- Delete calls whose recursive option sits in a variable: none. The four delete calls without an inline recursive option are empty-folder removals that cannot delete a tree.
- Git clean and hard reset: none as calls; they appear only in a prompt that forbids them.

## Proof

Old scan, new probe cases, strict mode: exit 1.

```text
typed shell removal: detected 0, bypasses 0; required 1, 1
spawned shell removal: detected 0, bypasses 0; required 1, 1
guarded shell control: detected 0, bypasses 0; required 1, 0
```

`node atris/receipts/work-folder-scan-probe.js --require-protection` with the new scan: exit 0, nine cases, `review gaps: 0`.

`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`: exit 0, 24 passed, 0 failed.

Old scan versus new scan over the real code: 17 sites each, identical locations and results.

`atris slop detect` on both changed files: clean. `atris doc-health --fix-refs`: no refs moved.

next_push: check the four removals the scan exempts against today's findings, starting with the review sandbox setup failure path, which deletes the same quarantine store that turned out to need a lock check.

layer: capabilities

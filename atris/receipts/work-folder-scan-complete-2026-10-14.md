# Removal scan closes its last two gaps

The scan that fails unprotected folder deletes no longer accepts a comment as protection, and it reads a delete call spread across several lines as one statement. The strict scan probe now passes with zero gaps. That probe exiting 1 is what blocked the last landing even though every test passed.

## What changed

`test/worktree-removal-guard.test.js`:

- Comment lines and trailing comments are dropped from a function's text before the scan looks for the git check and the removal log, so a note naming them no longer counts.
- A delete call is read from its opening line to the line that closes it, so moving the arguments onto their own lines no longer hides it.

## Proof

`node atris/receipts/work-folder-scan-probe.js --require-protection`: exit 0.

```text
comment-only protection: detected 1, bypasses 1; required 1, 1
multiline generic removal: detected 1, bypasses 1; required 1, 1
review gaps: 0; synthetic source only, no folders removed
```

`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`: exit 0, 24 passed, 0 failed.

Old scan versus new scan over the real code: 17 sites each, identical locations and identical protected or unprotected results. No real code relied on either gap.

`atris slop detect test/worktree-removal-guard.test.js`: clean. `atris doc-health --fix-refs`: no refs moved.

Both review probes now pass their strict mode: sandbox cleanup and the source scan.

next_push: add a land reap test that puts a git lock in the shared store of a linked work folder, so reap's own guard is proven against the same shared-store gap that sandbox cleanup had.

layer: capabilities

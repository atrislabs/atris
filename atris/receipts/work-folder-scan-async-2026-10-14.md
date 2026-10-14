# Removal scan catches callback and promise deletes

The scan that fails any folder delete skipping the git check or the removal log now recognizes callback and promise deletes, not only the synchronous form. Before, a new cleanup written in async style could delete a work folder with no check and no log, and every test stayed green.

## What changed

`test/worktree-removal-guard.test.js`: both delete patterns in the scan now match `fs.rm(` and `fs.promises.rm(` as well as `rmSync(`. No such deletes exist in the code today, so this is preventive. The real-code scan still passes, which means no hidden site turned up.

## Proof

Old patterns against the two shapes:

```text
old pattern misses -> fs.rm(dir, { recursive: true }, () => {});
old pattern misses -> await fs.promises.rm(dir, { recursive: true });
```

`node atris/receipts/work-folder-scan-probe.js`: exit 0.

```text
callback removal: detected 1, bypasses 1; required 1, 1
promise removal: detected 1, bypasses 1; required 1, 1
comment-only protection: detected 1, bypasses 0; required 1, 1
multiline generic removal: detected 0, bypasses 0; required 1, 1
review gaps: 2; synthetic source only, no folders removed
```

Open scan gaps went from 4 to 2.

`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`: exit 0, 24 passed, 0 failed.

`atris slop detect test/worktree-removal-guard.test.js`: clean. `atris doc-health --fix-refs`: no refs moved.

next_push: stop a comment that merely names the git check and the log from counting as protection, so the comment-only gap closes.

layer: capabilities

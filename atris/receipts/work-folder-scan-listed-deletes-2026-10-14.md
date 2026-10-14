# Exempt cleanups list each delete by folder

The four cleanups exempt from the git check, and the review sandbox group, now list every delete they hold by the folder it removes. Before, each was pinned only by a count. When that count changed, the failure said "expected 6, found 7", and a reviewer had to diff the function to find which delete was new.

Now a new delete is reported with its line and folder, and a listed delete that disappeared is reported by folder. Nothing that passed before fails now.

To make the drill cleanup's folder readable, the scan now takes the last unquoted entry in a git removal list. Before, it took only the very last entry, and the drill passes an option after the folder.

## Proof

Real-source change, made together, then both files restored with git: added a new delete of the project's installed packages folder to the green landing scratch setup, and removed one seed folder delete from the review sandbox setup.
```text
changed-code exit 1
  AssertionError [ERR_ASSERTION]: an exempt or grouped function gained or lost a delete; review it, then update its list
  +   'lib/fleet.js:prepareReviewSandbox: listed delete of seedDir is gone',
  +   "lib/land-green.js:scratchCheckout (line 185): new delete of path.join(root,'node_modules')"
restored
```
The previous count check would have said the scratch setup went from 1 to 2 deletes and the sandbox setup from 6 to 5, without naming either.

All three probes with `--require-protection`, exit 0: path binding `review gaps: 0`, saved examples `review gaps: 0`, group `4 recursive targets; 0 missing from scan`.

Required check: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0:
```text
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

Files edited: `test/worktree-removal-guard.test.js`, `atris/refs/MAP-NOTES.md`, this receipt, `atris/team/architect/logs/2026-10-14.md`.

next_push: run the full worktree and tidy test files beyond the frozen two, and fix any that fail, so the mission's "keep all worktree and tidy tests green" is measured, not assumed.

layer: capabilities

# Each folder safety scan failure says what to fix

When the folder safety scan fails, each flagged delete now carries a plain reason next to its line number. Before, the message listed only the function and line, so a builder had to work out which of several rules broke.

The reasons:
- could not tell which folder is deleted
- no git check names the folder
- the git check on the folder only comes after the delete
- the git check's answer never stops the delete
- the removal log does not name the folder
- for the review sandbox group: a group check is missing above the delete, a group check never stops it, or the group log does not name the work folder

What passes and fails is unchanged. The path probe now requires the exact reason for each of its nine cases, so a wrong reason fails the required checks.

## Proof

`node atris/receipts/work-folder-scan-binding-probe.js --require-protection`, exit 0:
```text
matching folder control: detected 1, bypasses 0; required 1, 0
resolved same folder control: detected 1, bypasses 0; required 1, 0
unrelated folder guard: detected 1, bypasses 1; required 1, 1; reason: no git check names worktreePath
unrelated folder log: detected 1, bypasses 1; required 1, 1; reason: removal log does not name worktreePath
unrelated folder protection: detected 1, bypasses 1; required 1, 1; reason: no git check names worktreePath
check only after the delete: detected 1, bypasses 1; required 1, 1; reason: git check on worktreePath only comes after the delete
answer ignored: detected 1, bypasses 1; required 1, 1; reason: git check answer on worktreePath never stops the delete
answer stored and never read: detected 1, bypasses 1; required 1, 1; reason: git check answer on worktreePath never stops the delete
delete inside the not-busy branch control: detected 1, bypasses 0; required 1, 0
review gaps: 0; synthetic source only, never executed
```

Real-source changes, made together, then both files restored with git: the green landing cleanup warns instead of returning on a busy folder, and the review sandbox's quarantine store check moves below its first two deletes.
```text
changed-code exit 1
  +   'lib/fleet.js:disposeReviewSandbox (line 2473): group check gitStoreActivity(boundary.quarantine) is missing above this delete',
  +   'lib/fleet.js:disposeReviewSandbox (line 2474): group check gitStoreActivity(boundary.quarantine) is missing above this delete',
  +   'lib/fleet.js:disposeReviewSandbox (line 2475): group check gitStoreActivity(boundary.quarantine) is missing above this delete',
  +   'lib/land-green.js:dropScratch (line 200): git check answer on dir never stops the delete',
  +   'lib/land-green.js:dropScratch (line 201): git check answer on dir never stops the delete'
restored
```

Saved examples and group probes, both with `--require-protection`, exit 0: `review gaps: 0` and `group: 4 recursive targets; 0 missing from scan`.

Required check: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0:
```text
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

Files edited: `test/worktree-removal-guard.test.js`, `atris/receipts/work-folder-scan-binding-probe.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, `atris/team/architect/logs/2026-10-14.md`.

next_push: give the four exempt cleanups the same reason treatment, so an exempt function that gains a delete says which delete is new instead of only a changed count.

layer: capabilities

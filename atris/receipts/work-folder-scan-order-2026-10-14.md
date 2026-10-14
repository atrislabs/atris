# The safety scan requires the git check before the delete

The folder safety scan now counts a git check only when it is written above the delete it protects. A check placed after a deletion used to pass, even though the folder was already gone by the time it ran. The removal log can still come after, since it records what happened.

The review sandbox group follows the same rule: all three store checks must sit above each of its five deletes.

No production code changed. All six guarded real cleanups already check first.

## Proof

`node atris/receipts/work-folder-scan-binding-probe.js --require-protection`, exit 0:
```text
matching folder control: detected 1, bypasses 0; required 1, 0
resolved same folder control: detected 1, bypasses 0; required 1, 0
unrelated folder guard: detected 1, bypasses 1; required 1, 1
unrelated folder log: detected 1, bypasses 1; required 1, 1
unrelated folder protection: detected 1, bypasses 1; required 1, 1
check only after the delete: detected 1, bypasses 1; required 1, 1
review gaps: 0; synthetic source only, never executed
```
The same probe run against the previous scan, from the last commit:
```text
check only after the delete: detected 1, bypasses 0; required 1, 1
review gaps: 1; synthetic source only, never executed
```

Real-source move: in the review sandbox cleanup, moved the quarantine store check below the first two deletes, which is the half-deleted sandbox its comment warns about. Ran the scan, then restored the file with git.
```text
moved-check exit 1
  +   'lib/fleet.js:disposeReviewSandbox (line 2473)',
  +   'lib/fleet.js:disposeReviewSandbox (line 2474)',
  +   'lib/fleet.js:disposeReviewSandbox (line 2475)'
restored
```
Exactly the three deletes that ran before the moved check were flagged; the two after it passed.

Saved examples and group probes, both with `--require-protection`, exit 0: `review gaps: 0` and `group: 4 recursive targets; 0 missing from scan`.

Required check: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0:
```text
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

Also fixed two older navigation lines in the notes that pointed at the wrong regression tests.

Files edited: `test/worktree-removal-guard.test.js`, `atris/receipts/work-folder-scan-binding-probe.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, `atris/team/architect/logs/2026-10-14.md`.

Remaining risk: source order is not run order. A check above the delete inside a branch that skips it would still pass; the real lock and process tests carry that.

next_push: require the check's result to stop the delete, so a check whose answer is ignored stops counting.

layer: capabilities

# The safety scan requires the git check's answer to stop the delete

The folder safety scan now counts a git check only when its answer can stop the deletion. That means one of two shapes, written above the delete: a test on the answer that returns, continues, breaks, or throws, or a test on "not busy" whose branch holds the delete. The answer can be read in place or through the name it was stored under.

Before this change, calling the check and ignoring what it said still passed. So did storing the answer and never reading it.

The review sandbox group follows the same rule for all three of its store checks. No production code changed: all six guarded real cleanups already let the answer stop the delete.

## Proof

`node atris/receipts/work-folder-scan-binding-probe.js --require-protection`, exit 0:
```text
matching folder control: detected 1, bypasses 0; required 1, 0
resolved same folder control: detected 1, bypasses 0; required 1, 0
unrelated folder guard: detected 1, bypasses 1; required 1, 1
unrelated folder log: detected 1, bypasses 1; required 1, 1
unrelated folder protection: detected 1, bypasses 1; required 1, 1
check only after the delete: detected 1, bypasses 1; required 1, 1
answer ignored: detected 1, bypasses 1; required 1, 1
answer stored and never read: detected 1, bypasses 1; required 1, 1
delete inside the not-busy branch control: detected 1, bypasses 0; required 1, 0
review gaps: 0; synthetic source only, never executed
```
The same probe run against the previous scan, from the last commit:
```text
answer ignored: detected 1, bypasses 0; required 1, 1
answer stored and never read: detected 1, bypasses 0; required 1, 1
delete inside the not-busy branch control: detected 1, bypasses 0; required 1, 0
review gaps: 2; synthetic source only, never executed
```

Real-source change: in the green landing cleanup, made a busy folder print a warning instead of returning, so the delete runs anyway. Ran the scan, then restored the file with git.
```text
ignored-answer exit 1
  +   'lib/land-green.js:dropScratch (line 200)',
  +   'lib/land-green.js:dropScratch (line 201)'
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

Remaining risk: the scan reads shapes, not meaning. A test that can never be true, or a stop inside a branch that also skips for other reasons, still reads as protection. The real lock and process tests carry that.

next_push: make the scan's unreadable-target gaps name the reason in the failure message, so a builder sees "could not tell which folder" instead of a bare line number.

layer: capabilities

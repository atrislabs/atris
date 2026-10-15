The safe review drain test now starts 10 commands instead of 11; its focused check passed 3 of 3 and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

What changed: the snapshot of the row waiting for a human, taken before the drain runs, now reads the same enriched task view the show command prints, straight from the task store. Certification, both scoped drains, the text alias and the after-drain read of that row still run through the real CLI, so the test still proves the drain leaves the human-gated row untouched.

Timing (single-test runs, same machine, normal PATH):
```text
before: 1866ms 1884ms 1869ms
after:  1875ms 1857ms 1870ms
```
The saved launch does not show up in wall time here; the difference is inside run-to-run noise. The gain is one fewer process per run, not a measured speedup.

Navigation line refs below the edit moved 10 lines, each checked against the old line's text (182 moved, 0 skipped).

Rerunnable verification command:
`node --test --test-name-pattern='^task review-lane-drain picks safe agent action without mutating human accept rows$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (3 of 3 runs)
verifier: tests 35, pass 35, fail 0, exit=0
git diff --check: exit=0
slop detect on added lines: clean
```

next_push: Re-rank the commands tests with plain git and pick the slowest remaining check by measured time, since single-snapshot reads have stopped moving wall time.
layer: capabilities

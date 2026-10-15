The test that holds work in review until a human accepts it now runs about 0.1s faster with one fewer command launch; both changed tests passed and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

What changed: timing each launch showed 15 launches at about 130ms each, and only the first one, which creates the task, was setup. That row is now written straight to the task store with the same goal fields the add command writes for its goal flags. This test was the only place that checked add actually saves those goal fields. So those two checks moved onto the local XP ledger test, which already runs a real add with the same flags, and no coverage was lost. Every ready, review, next, status and accept step still runs through the real CLI.

How the saving was measured (old and new versions alternated eight times each, plain git first on PATH):
```text
old: mean 2212ms over 8 runs
new: mean 2111ms over 8 runs
```

Navigation line refs below the edits moved, each checked against the old line's text (146 moved, 0 skipped); this test's notes now point at its current lines.

Rerunnable verification command:
`node --test --test-name-pattern='^(task ready holds work in review until human accept|task accept automatically projects accepted proof into durable local XP ledger)$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
both changed tests: tests 2, pass 2, fail 0, exit=0 (plus 8 of 8 new-version timing runs passed)
verifier: tests 35, pass 35, fail 0, exit=0
git diff --check: exit=0
slop detect on added lines: clean
```

next_push: Re-rank the commands tests with plain git; the top three have each had their setup-only launches cut, so the next target should come from fresh measured times.
layer: capabilities

The task page test now runs about 0.12s faster with one fewer command launch; it passed 3 of 3 plus 8 of 8 timing runs, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: a fresh plain-git ranking of the commands file (437 of 437 passed, 152s) showed the three slowest tests had already been cut. Timing each launch in the next four found the task page test spending launches on stepping its task through stages, while the page reads are what it actually checks.

What changed: the step that moves the task into the Do stage is a single store call in the CLI, and the page reads straight from the store, so that step now runs in process. Plan stays on the CLI because it also works out the owner and a plan trace. Chat, ready, review, every page read and the final show still run through the real CLI. Launches fall from 15 to 14.

How the saving was measured (old and new versions alternated eight times each, plain git first on PATH):
```text
old: mean 2106ms over 8 runs
new: mean 1988ms over 8 runs
```

Navigation line refs below the edit moved, each checked against the old line's text (159 moved, 0 skipped).

Rerunnable verification command:
`node --test --test-name-pattern='^task page exposes one-task goal chat stage and review actions$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (3 of 3 runs, plus 8 of 8 timing runs)
verifier: tests 35, pass 35, fail 0, exit=0
git diff --check: exit=0
slop detect on added lines: clean
```

next_push: Move the setup-only claims and releases in the headless JSON contract test (four claims, two releases) to the task store where they are not the step being checked.
layer: capabilities

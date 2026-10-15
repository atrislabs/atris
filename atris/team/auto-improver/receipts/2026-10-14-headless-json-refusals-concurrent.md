The test that checks the machine-readable task commands now runs about 0.40s faster, because its six refusal checks run in two groups at once instead of one by one; it passed 5 of 5 plus 8 of 8 timing runs, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Why it is safe: each refusal was read in the code before moving it. A refused claim, a refused release and a refused finish change no rows and skip the task list rewrite, and the store runs in a mode that lets readers share it with a 30 second wait on locks. The same test already ran eight read-only checks at once at its end. The event list it checks afterwards is unchanged, which proves no refusal wrote anything.

What changed: the claim refusal, the plain-text claim refusal and the release refusal run together while the task is held. The done refusal, the finish refusal and the plain-text finish refusal run together after the task is finished. Every assertion is unchanged and every launch still runs through the real CLI.

How the saving was measured (old and new versions alternated eight times each):
```text
old: mean 1961ms over 8 runs
new: mean 1563ms over 8 runs (faster in 8 of 8 pairs)
```

Navigation line refs below the edit moved using the exact line mapping from the diff, each checked against the old line's text (88 moved, 0 problems).

Rerunnable verification command:
`node --test --test-name-pattern='^task headless JSON contract supports create, claim, note, finish, and events$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (5 of 5 runs, plus 8 of 8 timing runs)
verifier: tests 35, pass 35, fail 0, exit=0
```

next_push: The backlog and clear-plan test launches the CLI 18 times one after another, the most of any test; find its setup-only or read-only launches and move them to the store or run them together.
layer: capabilities

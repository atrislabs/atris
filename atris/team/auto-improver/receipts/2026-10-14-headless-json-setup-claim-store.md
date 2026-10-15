The test that checks the machine-readable task commands now runs about 0.10s faster with one fewer command launch; it passed 3 of 3 plus 8 of 8 timing runs, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: last tick's handoff named this test. Reading it showed only one of its claims is pure setup: the first claim asserts nothing but a zero exit, and exists so the refusal checks have a held task to refuse. The later reclaim checks the full claim output, and both releases are the behavior under test, so they stay.

What changed: the setup claim now runs through the task store in process. It writes the same claim event the CLI writes, so the event list and version numbers the test checks are unchanged. Create, list, next, both refusals, both releases, reclaim, note, show, finish and every error check still run through the real CLI. Launches fall from 23 to 22.

How the saving was measured (old and new versions alternated eight times each):
```text
old: mean 2063ms over 8 runs
new: mean 1960ms over 8 runs (faster in 8 of 8 pairs)
```

Navigation line refs below the edit moved by six, each checked against the old line's text (78 moved, 0 mismatched).

Rerunnable verification command:
`node --test --test-name-pattern='^task headless JSON contract supports create, claim, note, finish, and events$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (3 of 3 runs, plus 8 of 8 timing runs)
verifier: tests 35, pass 35, fail 0, exit=0
```

next_push: In the same test, run the three claim and release refusals together, and the three finish refusals together, since none of them write; that cuts wall time without dropping any check.
layer: capabilities

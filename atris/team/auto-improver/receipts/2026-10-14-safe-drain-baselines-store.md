The safe drain action test now starts 11 commands instead of 13; its focused check passed 3 of 3 and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

What changed: the two "before" snapshots in the safe drain action test (before the review chat and before the dry run) now read the same enriched task view the show command prints, straight from the task store. Every "after" read, the dry run, both live actions and the human-only refusal still run through the real CLI, so the test still proves the commands change or leave the task as expected.

Timing (single-test runs, same machine, normal PATH):
```text
before: 2188ms 2150ms 2156ms
after:  2024ms 2014ms 1987ms
```

Also landed: leftover work from an earlier tick (the plain-git ranking receipt and lesson) plus navigation line refs moved 12 lines to match this edit, each one checked against the old line's text.

Rerunnable verification command:
`node --test --test-name-pattern='^task review-lane-act executes safe drain actions and refuses human accept rows$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (3 of 3 runs)
verifier: tests 35, pass 35, fail 0, exit=0
git diff --check: exit=0
slop detect on added lines: clean
```

Cost: none to behavior; the test reads two snapshots in process instead of through the CLI.

next_push: Read the before-snapshots in the review-lane-drain safe action test through the task store the same way, keeping its after reads on the CLI.
layer: capabilities

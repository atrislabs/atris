The two computer card tests now skip the full workspace setup, about 0.36s to 0.10s each, and the card test checks its memory line lists exactly the file it writes; both passed three runs, the check failed when that file was missing, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-computer-card-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^computer card' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
exit=0
✔ computer card prints local workspace card without auth (102.674125ms)
✔ computer card --write saves an inspectable markdown artifact (101.435458ms)
ℹ duration_ms 338.488
mutated exit=1
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Memory:\s+atris\/MAP\.md$/m.
    '  Memory:     none detected\n' +
card tests exit=0
ℹ tests 2
ℹ pass 2
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Metric: two init launches removed. Three runs before, both tests together: 881ms, 894ms, 854ms. Three runs after: 338ms, 350ms, 341ms.

Why it is safe: the card reads the package file, an optional business file, and whether the map, task list, wiki and logs exist. The first test writes its own package file, so it now writes only the map file too. The memory check is anchored to the end of the line, so the card must list the map and nothing else; before, any extra init files could pass. The write test only needs the atris folder, because that folder decides the card lands in atris/reports, and its other checks are fixed text.

Skipped on purpose: the analytics zero-completions test named in the handoff. An earlier tick kept init there because it checks what a fresh init produces.

Commands and artifacts: atris mission status; git status; reading both tests and the card builder; three timed runs before and after; a mutation run; both card tests; frozen verifier; ref shift script with a line match check (10 line numbers, all matched); atris doc-health (exit 0); atris slop detect.

next_push: Rerun the ranking of tests that still run a full init (now 26) and take the next one whose checks read only what the test writes; the two loop wiki tests at about 0.47s each are the next to check.
layer: capabilities

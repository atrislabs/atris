The three wiki loop tests now skip the full workspace setup, about 0.35s to 0.10s each, and two of them check the exact suggestion and summary line their inputs produce; all three passed three runs, a wording mutation made the tightened check fail, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-wiki-loop-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^(loop flags stale wiki|loop suggests next ingest|wiki loop alias)' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
wiki loop tests exit=0
ℹ tests 3
ℹ pass 3
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: changing the loop health line to always say "sources" made the suggestion test fail with a strict equality error; the source file was restored from git.

Metric: three init launches removed. Three runs before, all three tests together: 1202ms, 1186ms, 1178ms. Three runs after: 455ms, 423ms, 414ms.

Why it is safe: the wiki loop builds its own wiki folder before reading it, and it suggests sources only from a fixed list of files that exist. On a bare folder with just README.md the report is one suggested source, no stale pages, no orphans. With init, the same report also listed two init files, so the old check passed on anything that contained README.md. The suggestion test now requires exactly README.md and the exact health line, and the alias test requires the exact summary counts.

Commands and artifacts: atris mission status; reading the loop command and the source suggester; a bare versus init comparison of the JSON report; three timed runs before and after; a mutation run; the three tests; frozen verifier; two line refs moved up by two lines in MAP-NOTES and checked against the test file; atris doc-health (exit 0); atris slop detect.

next_push: Rerun the ranking of tests that still run a full init and take the next one whose checks read only what the test writes.
layer: capabilities

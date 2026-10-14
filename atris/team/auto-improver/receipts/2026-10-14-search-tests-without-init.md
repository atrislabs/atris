Four search tests now skip the full workspace setup and run about three times faster together, 1.54s to 0.50s; all four passed in three runs and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-search-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^search (with no keyword|finds matches in journal|is case-insensitive|with no matches)' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
commands.test.js exit=0 ℹ pass 4 ℹ fail 0 ℹ duration_ms 494.047458
✔ search with no keyword prints usage (95.640416ms)
✔ search finds matches in journal files (99.951583ms)
✔ search is case-insensitive (99.96625ms)
✔ search with no matches prints no matches (92.747083ms)
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: four init launches removed. Three runs each against the previous version of the file: about 1.54s before and 0.50s after for the four tests, roughly 260ms saved per test.

Measurement first: a full init launch takes about 240ms whether the shared test task store is empty or a copy of the real 7,000-row one, so store growth is not the cost; the launch is. Search prints usage before it reads the folder, and the journal checks read only the log each test writes, so the workspace folder alone is enough. Multi-layer search over features, team, wiki and journal stays covered by a separate test that never used init.

Also checked: 1,312 rows in the real task store on this machine come from old test runs. None are from today; the test fence now sends those writes to a shared throwaway store. Those rows are real user data, so they were left alone.

Commands and artifacts: atris atris.md; read of the test fence and search entry; init timing with empty and large stores; focused tests; timing of old and new versions; frozen verifier; ref shift script (24 moved, every line matched); atris doc-health (exit 0); atris slop detect atris/refs/MAP-NOTES.md (clean); task new/claim/ready.

next_push: Swap the full init for a bare workspace folder in the three analytics tests, after checking which init files the analytics counts read.
layer: capabilities

# Help test refs repointed

Every test line ref in the map notes now opens on the test its note names; 24 refs moved, and all 35 required checks passed, exit 0.

Files: atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-help-test-refs.md.
Change: 24 refs across 21 notes, mostly help regressions plus brain compile, clean, launchpad and unknown command notes. Each was matched by test name; ranges now run from the test header to its closing line. Notes that cover two tests (auth plus account help, clean missing folder through dry run, brain compile stale plus custom front door) span both. The launchpad help smoke points at its row in the shared help sweep, since it has no test of its own.
Audit: a loop printed the target line for all 45 test refs in the file. Every start is a test header or the seed or row line its note names, and every range ends on a test close.
Doc health: map refs 963 right, 10 moved, 3 unclear, 0 gone, exit 0. Unchanged, because it skips refs with no name attached.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 24910.156083. Exit: 0.
Metric: stale test refs in the map notes went from about 25 to 0.
Lesson: the same audit loop can run after any test edit; anchoring refs to test names would stop the drift for good.
next_push: Return to test speed: seed the next slow task test's parents in process, keeping its checks on the CLI.
layer: beliefs

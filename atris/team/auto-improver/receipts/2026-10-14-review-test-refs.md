# Review test refs repointed

Three map notes about this mission's seeded review tests now point at the tests they describe; each ref lands on its test header or helper, and all 35 required checks passed, exit 0.

Files: atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-review-test-refs.md.
Change: four line refs moved to the review continuation status test, the certified accept queue test and its seed helper, and the proof-specific review chat test. Each match was confirmed by test name plus a body detail the note names (three seeded rows, unsafe and blocked queue items, goal metadata on the seeded row).
Check command: for r in 13962 14044 14055 11840; do sed -n "${r}p" test/commands.test.js; done
Output: the status test header, the accept queue test header, its seed helper, and the review chat test header.
Doc health: map refs 963 right, 10 moved, 3 unclear, 0 gone, exit 0. Unchanged, because it skips line refs that carry no name.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 25225.052417. Exit: 0.
Metric: four stale refs fixed; about 25 stale help regression refs remain.
Lesson: doc health only tracks refs it can tie to a name, so plain test line refs drift silently as the test file grows.
next_push: Repoint the stale help regression refs in the map notes to the tests they name.
layer: beliefs

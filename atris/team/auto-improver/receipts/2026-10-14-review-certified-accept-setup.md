The default review screen check now uses four launches instead of five; the focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-certified-accept-setup.md.

Rerunnable verification command:
`node --test --test-name-pattern='review default mode leads with certified accept' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
✔ review default mode leads with certified accept like first-minute (1168.369542ms)
ℹ pass 1
ℹ fail 0
focused_exit=0
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: one creation-only CLI launch removed, five to four. Three runs each against the previous version of the file: about 1.21s before, about 1.08s after. The real store keeps the title, review tag and workspace root, asserts insertion and a display reference, and closes before the CLI claim. Claim, ready, review and every review screen assertion are unchanged.

What broke first: the plain seed made claim fail with not found. Init writes its task snapshot from a different store, and that snapshot's task shares the seeded display reference, so the CLI resolved the reference to a task this store does not have. The old create command hid this by rewriting the snapshot. The test now drops the stale snapshot before claim; claim resolves from the store and rewrites the snapshot itself, so ready, review and the review screen see the same state as before.

Commands and artifacts: atris atris.md; git log/show; focused test; timing of old and new versions; frozen verifier; atris doc-health --fix-refs; atris doc-health; atris slop detect atris/refs/MAP-NOTES.md (clean); task new/claim/ready. Two task lineage refs in MAP-NOTES were already wrong before this tick and were corrected by hand; doc-health reported zero moved.

Lesson: a seeded task can collide with the init snapshot by display reference, because both stores start counting at one under the same workspace prefix. Any seeded test that then names the task by display reference must drop or rebuild that snapshot first.

next_push: Replace the creation-only launch in the next review or status test that still runs task new only to get a task, applying the snapshot drop when it uses init.
layer: capabilities

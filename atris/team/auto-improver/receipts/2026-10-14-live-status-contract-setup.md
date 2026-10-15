The live status contract check now uses four launches instead of seven; the focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-live-status-contract-setup.md.

Rerunnable verification command:
`node --test --test-name-pattern='task status gives web and Swarlo a compact live contract' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
✔ task status gives web and Swarlo a compact live contract (577.587167ms)
focused exit=0
ℹ pass 1
ℹ fail 0
frozen exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: three creation-only CLI launches removed, seven to four (43%). The real store keeps the three titles, the swarlo and agent tags, the untagged backlog record and creation order, asserts each insertion, and closes before the CLI claim. Claim, JSON counts, current and next selection, text status and history feed assertions are unchanged. The create command adds no metadata without flags, so title, tag and workspace root are its full creation contract.

Commands and artifacts: atris atris.md; git log/show; baseline read of the test and the create handler; focused test; frozen verifier; atris doc-health; atris slop detect atris/refs/MAP-NOTES.md (clean); git diff --check; task new/claim/ready. Task AIC-16 is ready for human approval, never self-accepted. The first ready call ran under an older Node without the built-in sqlite module and refused; the retry named /opt/homebrew/bin/node and passed: atris/runs/2026-10-14-task-aic-16-2026-10-14T20-34-02-992Z.json. Two long-title refs in MAP-NOTES shifted seven lines and were corrected by hand because doc-health reported zero moved. Generated TODO view restored.

Lesson: doc-health can call a ref right when it still lands on a nearby line; recheck line refs below any edit by grepping the test name.

next_push: Replace the creation-only launch in the review default mode certified accept test, keeping claim, ready, review and the review screen on the CLI.
layer: capabilities

The backlog demotion check now skips two setup launches; the focused test passed in all three runs and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-backlog-demotion-setup.md.

Rerunnable verification command:
`node --test --test-name-pattern='task backlog and clear-plan demote only planned open tasks' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
commands.test.js exit=0 (2403.746958ms) ℹ pass 1 ℹ fail 0
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: two creation-only CLI launches removed. Three runs each against the previous version of the file: about 2.67s before, about 2.44s after. The real store keeps both titles, the capture and plan tags, the workspace root and creation order, asserts both insertions and display references, and closes before the CLI plan. The add command stores nothing else without flags, nothing in it reads the agent setting, and no init runs, so no stale task snapshot exists. Plan, backlog, show, do and every later assertion are unchanged.

Refs: the edit added 8 lines. The shift script first refused a 9-line shift because the moved lines did not match, then shifted 98 note refs by 8 with every line matched. The setup note audit stays at 55 of 57.

Commands and artifacts: atris atris.md; read of the add handler; focused test; timing of old and new versions; frozen verifier; ref shift script; atris doc-health (exit 0); atris slop detect atris/refs/MAP-NOTES.md (clean); task new/claim/ready.

Why not the docs health check from the last handoff: that command ships to every user project, and a check built on this repo's note style would be product scope creep for a test speed mission. The shift script with its line match guard already catches drift in this lane.

next_push: Measure what a full init launch costs in test setup and replace it in one test that only needs the atris folder, since the remaining add launches all test the add command itself.
layer: capabilities

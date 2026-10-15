# Failed-blocker status setup reduction

The failed-blocker status test uses three command launches instead of four. Its focused real CLI check and all 35 required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Plan: inspect -> seed ownership -> focused real CLI check and frozen checks -> review and push.

Change: claim the seeded task using production taskStore.claimTask in the creation connection, assert success and close in finally. Failed completion and both status reads retain real CLI coverage; every behavior assertion remains unchanged.

Commands and real output:
```text
node --test --test-name-pattern='^task status keeps failed blockers out of review handoff$' test/commands.test.js
✔ task status keeps failed blockers out of review handoff (422.333708ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 577.251041
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 11464.147625
exit 0
```

Metric: one setup subprocess removed, four launches to three (25% fewer). No matched timing baseline, so no wall-time saving is claimed.

Review: AIC-70 is ready for human review. The ready gate reran the focused check with /opt/homebrew/bin/node successfully, exit 0; absolute runtime paths are outside its auto-certify allowlist, so no automatic acceptance is claimed.

Upkeep: brain activation and compile were plan-only. Generated brain and wiki files listed at startup were absent and left alone. Pre-existing edits remain unstaged; only this increment is committed and pushed.

next_push: Remove the setup-only ownership launch from the mission XP weak-proof rejection test, retaining CLI creation and both proof gates.
layer: capabilities

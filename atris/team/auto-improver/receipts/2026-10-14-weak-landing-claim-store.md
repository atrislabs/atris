# Weak landing rejection setup claim uses the store

The weak landing rejection test now uses three CLI launches instead of four. The focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt. Task commands refreshed atris/TODO.md. Existing notebook changes were preserved and excluded from staging.

Plan: real-store creation -> real-store claim -> both CLI rejections -> CLI show.

The existing setup connection now calls claimTask and asserts success before closing. Every rejection and final claimed-state assertion remains unchanged. No production code changed.

## Proof

Baseline command: `node --test --test-name-pattern='^task ready rejects an explicit landing sentence a day-one PM cannot act on before review$' test/commands.test.js`
Output, exit 0: focused test passed, 512.83175ms; total duration 645.917916ms.

Rerun command: `/opt/homebrew/bin/node --test --test-name-pattern='^task ready rejects an explicit landing sentence a day-one PM cannot act on before review$' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output, exit 0:
```text
✔ task ready rejects an explicit landing sentence a day-one PM cannot act on before review (411.029ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 547.35637
...
ine benched at error routes again once the window passes, and with no stamp at once (44.438417ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10942.360375
```

Metric: four to three CLI launches, 25% fewer. Focused duration 512.83175ms to 411.029ms; single runs are observations, not speed guarantees.

Commands also run: brain activate, mission status and goal, git status/diff/log/remote, task list/new/claim/note/ready, brain compile, git diff --check, git add/commit/push. Brain activation and compile were plan-only with no generated edits. The first task proof attempt used bare node and failed because its runner found an older Node without node:sqlite; the installed /opt/homebrew/bin/node passed. Successful task proof: atris/runs/2026-10-14-task-aic-57-2026-10-14T22-53-51-836Z.json. Task is in Review, never self-accepted. The proof runner reports absolute-path commands require independent review for automatic landing.

Lesson: Setup-only claims can use the production claim operation while rejection behavior stays on the real CLI.

next_push: Replace the setup-only claim in the non-positive reward rejection test with the real task store while retaining readiness, rejection and review-status CLI checks.
layer: capabilities

# Reward rejection setup claim uses the store

The reward rejection test now launches three commands instead of four. The focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt. Task commands refreshed atris/TODO.md. Inherited notebook changes remain unstaged; only this increment's appended log entry is staged.

Plan: real-store creation -> real-store claim -> CLI ready -> CLI rejection -> CLI show.

The existing setup connection calls claimTask and asserts success before closing. Every readiness, zero-reward rejection, review-status and pending-approval assertion remains unchanged. No production code changed.

## Proof

Rerun command: `/opt/homebrew/bin/node --test --test-name-pattern='^task accept rejects non-positive rewards before marking done$' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
```text
✔ task accept rejects non-positive rewards before marking done (493.007583ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 664.239584
✔ the run record rotate
...
gine benched at error routes again once the window passes, and with no stamp at once (46.528375ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11284.51675
```

Proof artifact: atris/runs/2026-10-14-task-aic-58-2026-10-14T22-55-16-832Z.json

Metric: four to three CLI launches, 25% fewer in this test. Focused test duration 493.007583ms is an observation, not a speed guarantee.

Commands also run: git status/log/remote/diff, mission status/goal, task list/new/claim/note/ready, brain activate/compile, git diff --check, git add/commit/push. Brain activation and compile were plan-only, with no generated edits; compile exited 2 requesting --yes. Task is in Review and was never self-accepted. The proof runner reports that absolute-path commands require independent review for automatic landing. The user authorized pushing this safe internal change, so the change is committed and pushed without task acceptance.

Lesson: Setup-only claims can use the production claim operation while rejection behavior stays on the real CLI.

next_push: Replace the setup-only claim in the proof-only acceptance guard test with the real task store while retaining every CLI acceptance guard and saved-state assertion.
layer: capabilities

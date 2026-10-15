# Proof-only acceptance setup claim uses the store

The acceptance guard test now uses eight command launches instead of nine. Its focused check and all 35 frozen checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt. Task commands refreshed atris/TODO.md. Inherited notebook changes are preserved and excluded from the commit; only this increment's final appended lesson is staged from the member log.

Plan: store creation -> store claim -> CLI guards -> CLI ready and zero review -> CLI guards -> CLI saved-state read.

The existing setup connection calls the production claimTask operation and asserts success before closing. Every blocked done, finish, positive review, accept and certified auto-accept command remains on the CLI, alongside readiness, zero review and final pending-approval assertions. No production code changed.

## Proof

Rerun command: `/opt/homebrew/bin/node --test --test-name-pattern='^task proof-only agent env blocks acceptance verbs$' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Real command output excerpt, exit 0:
```text
✔ task proof-only agent env blocks acceptance verbs (1058.990625ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 1199.899209
...
✔ an engine benched at error routes again once the window passes, and with no stamp at once (42.63675ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 10100.798417
```

Metric: nine to eight CLI launches, 11% fewer. Duration is an observation, not a speed guarantee.

Commands also run: git status/log/remote/diff, mission status/goal, task list/new/claim/note/ready, brain activate/compile, git diff --check, git add/commit/push. Brain activation and compile were plan-only and generated no edits; compile exited 2 requesting --yes. Task proof is in Review, never self-accepted. Saved proof: atris/runs/2026-10-14-task-aic-59-2026-10-14T22-56-44-875Z.json. Automatic certification requires independent review because its runner cannot relocate absolute-path commands; pushing this internal change does not accept the task. The user authorized committing and pushing this safe internal change.

Lesson: Setup-only ownership can use the production store operation while all agent acceptance protections still run through the real CLI.

next_push: Replace the setup-only claim in the auto-accept confirmation test with the real task store while retaining all human-confirmation and acceptance CLI assertions.
layer: capabilities

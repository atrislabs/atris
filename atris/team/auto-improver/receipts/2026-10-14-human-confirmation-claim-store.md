# Human confirmation setup claim uses the store

The human-confirmation test now uses 13 CLI launches instead of 14. The focused test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt. Task commands refreshed atris/TODO.md. Inherited notebook edits are preserved and excluded from this commit; only the appended lesson below is staged from the member log.

Plan: store creation -> store claim -> CLI readiness and reviews -> CLI confirmation guards and previews -> CLI acceptance and saved-state checks.

The existing setup connection calls production claimTask and asserts success. All human-confirmation, actor, strict verification, preview and final acceptance assertions remain unchanged on the real CLI. No production code changed.

Rerun command: `/opt/homebrew/bin/node --test --test-name-pattern='^task auto-accept-certified requires explicit human confirmation$' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Real command output excerpt, exit 0:
```text
✔ task auto-accept-certified requires explicit human confirmation (1797.089583ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 1930.175666
...
✔ an engine benched at error routes again once the window passes, and with no stamp at once (39.607ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 10348.136083
```

Metric: 14 to 13 CLI launches, one fewer (7.1%). Duration is an observation, not a speed guarantee. The initial task note overcounted the launches; the measured correction is recorded in the task.

Commands also run: mission status/goal, task list/new/claim/note/ready, brain activate/compile, git status/log/remote/diff, git diff --check, git add/commit/push. Brain activation and compile were plan-only and generated no edits. Task readiness reran both test commands successfully and saved atris/runs/2026-10-14-task-aic-60-2026-10-14T22-58-13-999Z.json. Proof is in Review, never self-accepted; independent review remains necessary because automatic certification cannot relocate absolute-path commands. The user authorized pushing this safe internal change.

Lesson: Use production ownership setup when claim output is unused, and keep all acceptance protections on the real CLI.

next_push: Replace the setup-only claim in the duplicate reward review test with the real task store while retaining readiness, acceptance, duplicate review and XP status CLI checks.
layer: capabilities

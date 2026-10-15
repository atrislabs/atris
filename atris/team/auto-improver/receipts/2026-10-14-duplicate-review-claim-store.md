# Duplicate reward review setup claim uses the store

The duplicate reward review test now launches four commands instead of five. The focused check and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt. Task commands refreshed atris/TODO.md; inherited notebook edits are preserved and excluded from this commit.

Plan: store creation -> store claim -> CLI readiness -> CLI acceptance -> CLI duplicate review -> CLI XP status.

The existing setup connection calls production claimTask and asserts success. Every readiness, acceptance, duplicate reward, receipt count and response-size assertion remains on the real CLI. No production code changed.

Rerun command: `node --test --test-name-pattern='^task review after acceptance cannot mint duplicate AgentXP$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Real command output excerpt, exit 0 for each command:
```text
✔ task review after acceptance cannot mint duplicate AgentXP (687.312542ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 830.195875
...
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 10159.592125
```

Metric: five to four CLI launches, one fewer (20%). Duration is an observation, not a speed guarantee.

Commands also run: mission status/goal, task list/new/claim/note/ready, brain activate/compile, git status/log/remote/diff, git diff --check, git add/commit/push. Brain activation and compile were plan-only and made no edits. Task readiness reran both checks and exited 0, saving atris/runs/2026-10-14-task-aic-61-2026-10-14T23-01-13-821Z.json. Proof is in Review, never self-accepted; independent review remains necessary because automatic certification cannot relocate absolute-path commands. The user authorized committing and pushing this internal change.

Lesson: Seed setup-only ownership through the production claim operation, preserving all duplicate reward checks on the real CLI.

next_push: Replace the setup-only claim in the duplicate receipt repair test with the real task store while retaining readiness, acceptance and repairing XP status CLI checks.
layer: capabilities

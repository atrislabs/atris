# Build

## Atris Side

Implemented:

- `selectCodexGoalMission()` chooses the active mission that should become the visible Codex goal.
- `refreshCodexGoalController()` writes `.atris/state/codex_goal.json` and `atris/status/codex-goal.md`.
- `goal.visible_goal` declares the exact chat-runtime bridge: read the current goal, keep matching goals, create when the slot is empty, complete after proof, then refresh the next candidate.
- `atris/skills/atris/SKILL.md` tells Codex runtimes to consume `goal.visible_goal` before choosing work.
- Mission `run`, `tick`, and `complete` refresh the controller after state changes.
- `goal-loop` provides a bounded overnight runner around the cheap heartbeat.

## Codex Runtime Requirement

Expose one of these APIs to the agent runtime:

```text
replace_goal(objective)
```

or:

```text
set_goal(objective)
```

or make this sequence legal:

```text
update_goal({ status: "complete" })
create_goal(nextObjective)
```

## Runtime Contract

1. Read `.atris/state/codex_goal.json`.
2. If `action` is `codex_goal_candidate` or `codex_goal_heartbeat`, read `goal.objective`.
3. Read `goal.visible_goal`.
4. If the current visible goal already matches `goal.objective`, keep working.
5. If the slot is empty or the prior goal is complete, call `create_goal({ objective: goal.objective })`.
6. After proof or verifier pass, call `update_goal({ status: "complete" })`, rerun `atris mission goal --json`, then create the next visible goal candidate.
7. Preserve the prior goal history for audit.
8. Do not require direct edits to Codex local state databases.

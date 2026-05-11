# Build

## Atris Side

Implemented:

- `selectCodexGoalMission()` chooses the active mission that should become the visible Codex goal.
- `refreshCodexGoalController()` writes `.atris/state/codex_goal.json` and `atris/status/codex-goal.md`.
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
3. If `goal.mission_id` differs from the visible goal's mission id, replace the visible Codex `/goal`.
4. Preserve the prior goal history for audit.
5. Do not require direct edits to Codex local state databases.

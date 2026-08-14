# Build

## Atris Side

Implemented:

- `selectCodexGoalMission()` chooses the active mission that should become the visible Codex goal.
- `refreshCodexGoalController()` writes `.atris/state/codex_goal.json` and `atris/status/codex-goal.md`.
- `goal.visible_goal` declares the exact chat-runtime bridge: read the current goal, keep matching active goals, create only when the active task has no goal, complete after proof, then stop that task.
- Direct `atris mission run "<new objective>"` conflicts now emit `native_goal_action.tool = "replace_goal"` and `native_goal_resolution.action = "replace_visible_goal"` instead of hiding the new mission behind an older visible slot.
- If native `get_goal` reports a paused non-matching objective with no Atris mission owner, `mission goal` emits `native_goal_action.tool = "replace_goal"` with `available = false` instead of incorrectly telling the runtime to `create_goal`.
- A paused native-only goal has no same-task fallback. Atris keeps the current task unchanged and requires a new dedicated Codex task for the different objective.
- `--allow-native-goal-supersede` no longer makes complete-then-create executable in the same task; it returns the same new-task requirement.
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
5. If the active task has no goal yet, call `create_goal({ objective: goal.objective })`.
6. If the prior goal is complete, stop and create a new dedicated Codex task for the candidate.
7. After proof or verifier pass, call `update_goal({ status: "complete" })` and stop that task.
8. Preserve the prior goal history for audit.
9. Do not require direct edits to Codex local state databases.

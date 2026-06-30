# Build

## Atris Side

Implemented:

- `selectCodexGoalMission()` chooses the active mission that should become the visible Codex goal.
- `refreshCodexGoalController()` writes `.atris/state/codex_goal.json` and `atris/status/codex-goal.md`.
- `goal.visible_goal` declares the exact chat-runtime bridge: read the current goal, keep matching goals, create when the slot is empty, complete after proof, then refresh the next candidate.
- Direct `atris mission run "<new objective>"` conflicts now emit `native_goal_action.tool = "replace_goal"` and `native_goal_resolution.action = "replace_visible_goal"` instead of hiding the new mission behind an older visible slot.
- If native `get_goal` reports a paused non-matching objective with no Atris mission owner, `mission goal` emits `native_goal_action.tool = "replace_goal"` with `available = false` instead of incorrectly telling the runtime to `create_goal`.
- The paused native-only fallback is explicit but not automatic: `update_goal({ status: "complete" }) -> create_goal(next) -> mission goal ack` is safe only after handoff proof says the paused goal is intentionally superseded. A native `replace_goal`, `cancel_goal`, or `supersede_goal` tool is the real product fix.
- `--allow-native-goal-supersede` is the service valve for stopped conversations: it marks that fallback sequence approved/executable, while Atris records the old paused goal as superseded instead of pretending the original work actually finished.
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

# Codex Goal Replacement

## Problem

Atris missions can now choose the next Codex goal candidate, but the candidate needs an explicit bridge contract before this Codex runtime can mirror it into the visible `/goal` UI.

## Success Criteria

- Atris owns mission selection and writes `.atris/state/codex_goal.json`.
- The candidate includes `goal.visible_goal`, a runtime-readable bridge for the chat goal tools.
- Codex owns the visible thread goal state.
- When the active mission finishes, Codex can replace the visible `/goal` with `codex_goal.json.goal.objective`.
- Replacement is atomic: the UI shows one current goal, not a stale completed goal plus a hidden local candidate.

## Current Evidence

- `atris mission goal --json` emits `codex_goal_candidate`.
- `atris mission goal --heartbeat --json` refreshes cheap overnight state.
- `atris mission goal-loop --max-wall 28800 --no-claude --json` polls cheaply and runs one due mission step only when due.
- This Codex session can complete a prior visible goal and then create a new visible goal.
- `create_goal(...)` still fails while a different thread goal is active, so the bridge must wait for proof or an empty goal slot.

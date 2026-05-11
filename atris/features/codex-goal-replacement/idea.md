# Codex Goal Replacement

## Problem

Atris missions can now choose the next Codex goal candidate, but this Codex runtime cannot write that candidate into the visible `/goal` UI after a goal is already active.

## Success Criteria

- Atris owns mission selection and writes `.atris/state/codex_goal.json`.
- Codex owns the visible thread goal state.
- When the active mission finishes, Codex can replace the visible `/goal` with `codex_goal.json.goal.objective`.
- Replacement is atomic: the UI shows one current goal, not a stale completed goal plus a hidden local candidate.

## Current Evidence

- `atris mission goal --json` emits `codex_goal_candidate`.
- `atris mission goal --heartbeat --json` refreshes cheap overnight state.
- `atris mission goal-loop --max-wall 28800 --no-claude --json` polls cheaply and runs one due mission step only when due.
- `create_goal(...)` currently fails while the thread already has an active goal.

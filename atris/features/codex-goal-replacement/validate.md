# Validate

## Local Atris Checks

```bash
node -c commands/mission.js
npm test -- test/mission-verifier.test.js test/mission-status.test.js
atris mission goal-loop --max-iterations 1 --no-claude --json
```

Expected:

- Mission tests pass.
- `goal-loop` returns `action: codex_goal_loop`.
- `final_state.goal.objective` is the next Codex-visible goal candidate when a mission exists.
- `final_state.goal.visible_goal.schema` is `atris.visible_chat_goal_bridge.v1`.
- `atris/skills/atris/SKILL.md` includes the visible chat goal mirror procedure.
- `.atris/state/codex_goal.json` is updated.

## Platform Acceptance Check

Given an active Codex thread goal and a different `.atris/state/codex_goal.json.goal.objective`:

1. Runtime reads the candidate.
2. Runtime reads `goal.visible_goal`.
3. Runtime completes the current visible goal only after proof or a safe handoff.
4. Runtime creates the visible `/goal` with the candidate objective.
5. Runtime reruns `atris mission goal --json` after completion to fetch the next candidate.
6. `get_goal()` returns the new objective.
7. No direct mutation of `~/.codex` state is required.

## Current Blocker

The runtime available in this session exposes:

- `get_goal`
- `create_goal`
- `update_goal(status: complete)`

It does not expose `replace_goal` or `set_goal`, and `create_goal` rejects while this thread already has a different active goal. The supported path is complete-after-proof, refresh, then create the next objective.

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
- `.atris/state/codex_goal.json` is updated.

## Platform Acceptance Check

Given an active Codex thread goal and a different `.atris/state/codex_goal.json.goal.objective`:

1. Runtime reads the candidate.
2. Runtime replaces the visible `/goal` text with the candidate objective.
3. `get_goal()` returns the new objective.
4. No direct mutation of `~/.codex` state is required.

## Current Blocker

The runtime available in this session exposes:

- `get_goal`
- `create_goal`
- `update_goal(status: complete)`

It does not expose `replace_goal` or `set_goal`, and `create_goal` rejects while this thread already has an active goal.

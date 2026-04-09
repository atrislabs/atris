---
name: improve
description: "Run one RL improvement tick on the workspace via POST /api/improve. Ships one verifiable change, scores it, writes the scorecard. The thing you pay for. Triggers on: improve, make this better, ship one thing, run a tick, get smarter."
version: 1.0.0
tags:
  - rl
  - improve
  - reward
  - tick
  - autopilot
---

# /improve

Runs one improvement tick on the workspace. Calls `POST /api/improve` on the backend, which plans one task, builds it, verifies it, and scores it. Returns what shipped + the reward. Writes the scorecard locally.

This is the product. The thing the user pays for. One call, one verifiable result.

## How it works

```
/improve
  → POST /api/improve { workspace: ".", mode: "full" }
  → backend picks a task, plans, builds, reviews, verifies
  → returns { task, reward, files_changed, verify_pass, summary }
  → CLI writes scorecard to .atris/presidio/scorecards.md
  → CLI reports result to user
```

The inference is Claude Code (or whatever model the backend uses). The environment is the folder. The endpoint is the bridge.

## On invoke

1. Read `~/.atris/credentials.json` for auth token
2. Read `.atris/business.json` for the API base URL (or default to `http://localhost:8000`)
3. Call `POST /api/improve` with:
   ```json
   {
     "workspace": "<current working directory>",
     "mode": "full",
     "model": "sonnet"
   }
   ```
4. Wait for response (may take 1-5 minutes)
5. On success:
   - Show what shipped (task name, files changed, verify result)
   - Show the reward score
   - Write scorecard to `.atris/presidio/scorecards.md`
   - Append tick to today's journal
6. On failure:
   - Show the error
   - Write a lesson to `atris/lessons.md`
   - Do not write a scorecard

## Modes

- `full` — plan, build, review, verify (default)
- `plan` — just pick the task and show what it would do
- `dry_run` — run everything but don't commit

## Fallback

If the backend is unreachable (no auth, no network, localhost not running), fall back to local mode: run `atris autopilot --auto --iterations=1` instead. Same loop, just local inference via `claude -p` subprocess. Report that it ran locally.

## Output

```
improved.

  task:    fixed the stale wiki ref in auth-flow.md
  verify:  pass (npm test, 143/143)
  reward:  +4
  files:   atris/wiki/briefs/auth-flow.md
  time:    47s

  scorecard updated.
```

## Rules

- One tick only. Never batch.
- Always verify. No reward without a check.
- Show what shipped, not what was attempted.
- Write the scorecard. This is the receipt.
- If verify fails, halt honestly and write a lesson.
- Fallback to local if backend is unreachable. Never error silently.
- The user pays because something real happened. Never fake it.

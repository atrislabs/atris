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

Run the CLI command — it does the whole tick (auth, the credit-metered call, scorecard, fallback):

```bash
atris improve            # one full tick: plan → build → verify → score (deducts credits)
atris improve plan       # show the plan only, change nothing
atris improve --json     # machine-readable result (this is what the member loop consumes)
atris improve --no-fallback   # fail loudly instead of running a local tick when the backend is down
```

Under the hood `atris improve` (`commands/improve.js`):

1. Loads the auth token via `utils/auth.loadCredentials`
2. `POST /api/improve { workspace, mode, model }` via `utils/api.apiRequestJson`
3. The backend plans, builds, runs the verify command, scores it, and **deducts Atris credits per successful tick** (`bill_tick`)
4. Writes a per-tick scorecard row to `.atris/state/scorecards.jsonl` (the receipt the brain ledger counts)
5. Falls back to a local autopilot tick **only** when you are not logged in or the backend is unreachable — a real error (insufficient credits, server error) is reported, never silently retried

The full-mode response does not echo `credits_deducted` (credits are still billed server-side), so the CLI shows "billed server-side" when the count is absent. To call the endpoint directly instead of the command, `POST /api/improve` with `{ workspace, mode, model }`.

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

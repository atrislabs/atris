---
name: improve
description: "Run one verified, scored improvement tick and write its receipt. Use when the user asks to improve, make this better, ship one thing, run a tick, or get smarter. `atris improve` alone shows metabolism vitals; use `atris improve tick` to ship work."
version: 1.1.0
tags:
  - rl
  - improve
  - reward
  - tick
  - autopilot
---

# /improve

Run one improvement tick on the workspace. A successful tick ships one result, passes a real verifier, receives a score, and writes a machine-readable scorecard.

One call means one verifiable result. Never turn one invocation into a hidden batch.

## Command contract

`atris improve` alone shows the self-improvement metabolism vitals. It does not ship a change.

Use the explicit `tick` subcommand when the user asks for improvement work:

```bash
atris improve tick                    # one full tick: plan, build, verify, score
atris improve tick --json             # the same tick as machine-readable output
atris improve tick plan               # plan only; no change or receipt
atris improve tick --dry-run          # execute without committing; no shipping receipt
atris improve tick --no-fallback      # report API failure instead of running locally
atris improve history                 # reward trend, credits, and pass rate
atris improve                         # vitals only
atris improve --json                  # vitals only as JSON
```

## Run one tick

1. Run `atris improve tick`, adding `--json` only when structured output is useful.
2. Inspect the returned source, task summary, verifier result, reward, files, and receipt path.
3. Count the tick only when `ok` is true, verification passed, and the scorecard was written.
4. Report what shipped and the exact verifier result. If the tick fails, report the failure and stop.

For a paid API tick, the CLI:

1. Loads credentials with `utils/auth.loadCredentials`.
2. Calls `POST /api/improve` with the workspace, mode, model, and dry-run setting.
3. Lets the backend plan, build, verify, score, and bill the successful tick.
4. Writes the normalized receipt to `.atris/state/scorecards.jsonl` and the human trail to the daily Atris journal.

The full response may omit the billed credit count. In that case the CLI reports that billing happened server-side instead of inventing a number.

## Local fallback

Local fallback is allowed when there is no login, the backend is unreachable, or the hosted backend cannot access the local workspace path. The CLI runs this exact bounded command internally:

```bash
atris mission run --due --headless --max-ticks 1 --complete-on-pass --json
```

The local result succeeds only when all of these are true:

1. Exactly one mission tick ran.
2. A headless worker actually ran; caller-session and no-worker placeholders are rejected.
3. The mission verifier passed.
4. The scorecard and journal receipt were written.

A verified local tick earns the conservative local reward of `+1` and deducts no credits. No due headless mission, a skipped worker, a failed or missing verifier, or a receipt write failure makes the improve command fail without a reward.

Do not silently fall back for answerable API failures such as insufficient credits, unrelated authorization failures, or server errors.

## Expected output

User says: "Improve this once."

Action: run `atris improve tick`.

Expected shape:

```text
improved.
  task:    fixed the stale wiki reference
  verify:  pass
  reward:  4
  files:   atris/wiki/auth-flow.md
  scorecard: .atris/state/scorecards.jsonl
```

For local fallback, the first line is `improved (local fallback).` and the report still names the task, passing verifier, reward, and scorecard.

## Failure handling

- If verification fails or is missing, halt honestly and write a durable lesson. Do not claim improvement.
- If the command reports no due headless mission, stop; do not manufacture busywork or a scorecard.
- If the API returns insufficient credits or another answerable error, report it without a local retry.
- If the workspace is dirty, preserve existing changes. Use an isolated worktree for manual follow-up fixes.
- If a worker lands work but the outer receipt fails, report the landed commit separately and do not count the improve tick.

## Rules

- One tick only. Never batch.
- No reward without a passing verifier.
- Show what shipped, not what was attempted.
- A scorecard is required for success.
- Preserve user work and unrelated changes.
- The user pays because something real happened. Never fake it.

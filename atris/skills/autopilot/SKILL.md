---
name: autopilot
description: "Run ONE autopilot tick. Scans workspace, picks the highest-priority work, executes plan→do→review on it, then stops. For autonomous recurring ticks, invoke /loop instead. Triggers on: autopilot, run one tick, ship one thing, do the next thing, get this done."
version: 3.0.0
tags:
  - autopilot
  - workflow
  - tick
---

# /autopilot

Runs ONE plan→do→review tick. Finds the highest-priority work, does it, then stops. Not a recurring loop — call `/loop` for that.

## When to use

- User says "run one tick", "do the next thing", "ship one thing", "get this done"
- User wants a single hands-off task executed
- The cron job from `/loop` invokes this on each fire

## What ONE tick does

1. **Scan** — read `atris/TODO.md`, today's journal `## Inbox`, `atris/wiki/STATUS.md`. Find the highest-priority work.
2. **Plan** — break it into one concrete task with a clear exit condition.
3. **Do** — execute the task. Make the changes. Verify they work.
4. **Review** — check quality, run tests if any, update `MAP.md` and journal.
5. **Stop** — do not pick a second task. One tick = one task.

## How to invoke

When the user invokes `/autopilot`, run this Bash command:

```bash
atris autopilot --auto --iterations=1
```

That's it. The CLI handles the suggest → plan → do → review flow via `claude -p` subprocesses. Show the output to the user.

## Variants

- `atris autopilot --dry-run` — preview what it would do, do not execute
- `atris autopilot --auto --iterations=N` — run up to N ticks back-to-back (still one task per tick)
- `atris autopilot "<task description>"` — seed a new inbox item, then run

## Autonomous mode

If the user wants this to fire on a recurring schedule without manual invocation, tell them to invoke `/loop` instead. `/loop` schedules a cron that calls `/autopilot` every ~13 min.

```
/autopilot  →  one tick, then stop
/loop       →  /autopilot every ~13 min (heartbeat)
```

## Rules

- One task at a time. Never batch.
- Always show *why* before executing.
- Stop after the first tick. Do not chain. Chaining is `/loop`'s job.
- If the workspace is clean (nothing to do), say so and stop.

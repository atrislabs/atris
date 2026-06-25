---
name: loop
description: "Schedule the recurring autopilot heartbeat. Calls CronCreate to fire one autopilot tick every ~15 min. Triggers on: /loop, start the loop, run the loop, autonomous mode, kick off the heartbeat."
version: 2.0.0
tags:
  - loop
  - autopilot
  - cron
  - heartbeat
---

# /loop

Schedules the recurring autopilot heartbeat. One tick fires roughly every 13–17 minutes via Claude Code's cron system.

## What it does

1. Calls `CronCreate` with a recurring schedule (off-clock minute to avoid fleet sync at :00 / :30)
2. The cron prompt first invokes `atris mission run --due --max-ticks 1 --complete-on-pass`; if no mission is due, it invokes `/autopilot`
3. Returns the cron job id so the user can stop it later with `CronDelete`
4. Lists the active cron jobs via `CronList` so the user can see the heartbeat is alive

## How to invoke

User says "run /loop", "start the loop", "kick off autonomous mode", or "make autopilot recurring".

The agent then:

1. Calls `CronCreate` with these args (use whatever off-clock minute you land on, do not pin to :00 or :30):
   - `cron`: `"*/13 * * * *"` (every 13 min) for tight loops, or `"7 * * * *"` (hourly at :07) for slow loops
   - `prompt`: `"First run: atris mission run --due --max-ticks 1 --complete-on-pass. If it reports no_due_mission, run /autopilot for one tick. One bounded goal only, then stop. Do not start a conversation."`
   - `recurring`: `true`
   - `durable`: `false` (in-memory only, gone when this Claude session ends)
2. After creating, calls `CronList` and shows the user the active cron jobs.
3. Tells the user: "loop is alive. job id <X>. fires roughly every <N> minutes. say 'stop the loop' to kill it. auto-expires after 7 days."

## Stopping the loop

When the user says "stop the loop", call `CronDelete` with the saved job id.

If the user says "kill all loops", call `CronList`, then `CronDelete` for every job.

## Rules

- One tick at a time. Never schedule a cron that fires more than once per 10 min.
- Always pick an off-clock minute (avoid :00 and :30) to prevent the global fleet from hammering the API at the same instant.
- Use `durable: false` by default. Only use `durable: true` if the user explicitly says "make this survive restarts" or "persist this".
- Auto-expires after 7 days. Tell the user.
- Cron only fires while Claude Code is idle (not mid-query). It will NOT run if Claude Code is closed.
- The CLI writes the heartbeat Notes block. Do not hand-write tick summaries to the journal.

## Why this is the heartbeat

`atris mission` is the north star. `/autopilot` is the fallback tick. `/loop` is the schedule:

```
/loop  →  CronCreate('*/13 * * * *', 'atris mission run --due ... || /autopilot')
              ↓
          every ~13 min while Claude Code is idle:
              ↓
          due mission? → one mission tick
          no mission?  → one autopilot tick
              ↓
          plan → do → review → stop
              ↓
          (cron fires again next interval)
```

This is the autonomous mode. Without `/loop`, `/autopilot` only runs when a human invokes it.

## The CLI front door and wiki upkeep

The CLI command `atris loop` is now the single front door to the self-improvement loop: `atris loop start` (local), `atris loop start --overnight` (durable heartbeat), `atris loop status`, `atris loop stop`. It delegates to the existing engines (`run`, `pulse`) rather than adding a new one.

Wiki upkeep (stale pages, orphans, ingest candidates) moved to `atris loop wiki` (or `atris wiki loop`). If the user wants wiki health, run that. If they want the autopilot heartbeat from inside Claude Code, invoke `/loop` here.

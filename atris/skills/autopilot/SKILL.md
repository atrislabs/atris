---
name: autopilot
description: "Run ONE autopilot tick. Reads identity (flow) + horizon (endgame), shows a visual status block, picks the next [endgame] task or seeds a new endgame at boundaries, then executes plan→do→review. Lessons compound to atris/lessons.md. Triggers on: autopilot, run one tick, ship one thing, do the next thing, get this done."
version: 3.2.0
tags:
  - autopilot
  - workflow
  - tick
  - endgame
  - flow
---

> **The two-engine architecture:** /flow chains forward from identity (who you are → next move). /endgame chains backward from horizon (where you're going → next move). They meet at the same intersection — the next thing /autopilot should ship. Each tick reads both sides and shows them in the visual status block.

## Visual status block

Every tick prints this BEFORE scanning for work, so you can see the loop's state at a glance:

```
  ┌──────────────────────────────────────────────────────────────┐
  │ tick · 14:23                                                 │
  │ identity:  building atris-business cloud for design partners │
  │ horizon:   customer-onboarding                               │
  │            three setup checks are ready to ship               │
  │ progress:  ████████░░░░  6/9 endgame steps                   │
  └──────────────────────────────────────────────────────────────┘
```

- **identity** comes from `atris/PERSONA.md` (first non-trivial line)
- **horizon** comes from the `## Endgame` section in `atris/TODO.md`
- **progress** counts `[endgame]`-tagged tasks in Backlog vs `T#/W#/E#`-prefixed entries in Completed

If identity is missing, edit PERSONA.md. If no horizon is active, /endgame seeds one from inbox / wiki / lessons.

# /autopilot

Runs ONE plan→do→review tick anchored to the current endgame. If no endgame is active, seeds one from the inbox or wiki signals first. Not a recurring loop — call `/loop` for that.

## When to use

- User says "run one tick", "do the next thing", "ship one thing", "get this done"
- The cron job from `/loop` invokes this on each fire

## What ONE tick does

1. **Read state** — load `atris/TODO.md`. Look for the `## Endgame` section header and `[endgame]`-tagged tasks in `## Backlog`.
2. **Boundary check** — if no `## Endgame` section exists, OR every `[endgame]`-tagged task in Backlog is done/missing, invoke `/endgame` first to seed the next horizon. `/endgame` will write a new `## Endgame` section + tagged backlog tasks to TODO.md.
3. **Execute** — run `atris autopilot --auto --iterations=1` via Bash. The CLI prefers `[endgame]`-tagged backlog tasks (priority 0) over reactive signals (priority 1+). One task per tick.
4. **Stop** — show the output, do not start a conversation, do not chain. The next tick is the cron's job.

## How to invoke

When the user (or cron) invokes `/autopilot`:

```
1. Read atris/TODO.md
2. If TODO.md has no `## Endgame` section OR no `[endgame]` tasks in Backlog:
     → Invoke `/endgame` first (it will write the new endgame to TODO.md)
3. Run: atris autopilot --auto --iterations=1
4. Show output
5. Stop
```

## Boundary behavior

The whole point of the architecture: **finish the current endgame before picking another.** Reactive signals (stale pages, broken refs) are fallbacks, not the main road. The main road is endgame → endgame → endgame, set by the human or seeded from inbox at every boundary.

```
TODO.md state                          → tick action
─────────────────────────────────────────────────────────────────────
no ## Endgame section                  → /endgame to seed, then run tick
## Endgame exists, [endgame] tasks 0   → /endgame to pick next, then run tick
## Endgame exists, [endgame] tasks 1+  → run tick (pick next [endgame] task)
no endgame anywhere, no inbox, clean   → loop journals "nothing left", stops
```

## Variants

- `atris autopilot --dry-run` — preview what it would do, do not execute
- `atris autopilot --auto --iterations=N` — run up to N ticks back-to-back (still one task per tick, boundary checks between)
- `atris autopilot "<task description>"` — seed a new inbox item, then run

## Autonomous mode

If the user wants this to fire on a recurring schedule, invoke `/loop` instead. `/loop` schedules a cron that calls `/autopilot` every ~13 min, with the boundary check baked in.

```
/autopilot  →  one tick (with boundary check at start)
/loop       →  /autopilot every ~13 min (heartbeat)
```

## Rules

- One task at a time. Never batch.
- Always show *why* before executing.
- Stop after the first tick. Do not chain. Chaining is `/loop`'s job.
- Endgame tasks always preferred over reactive signals.
- At every boundary (no current endgame OR all done), reassess via `/endgame` — read inbox/wiki/logs, pick the next horizon, do not just run forever.
- If a tick fails, halt and journal the failure. Do not pretend it worked.
- The CLI writes the heartbeat Notes block. Do not hand-write tick summaries to the journal.

---
name: endgame
description: "Backward partner to /flow. Picks the next horizon from inbox + wiki + lessons, writes the reverse path as tagged tasks to TODO.md so /autopilot can pursue it tick by tick. Triggers on: endgame, what's the last move, where are we heading, reverse engineer, work backward."
version: 1.2.0
tags: [planning, vision, reverse-engineer, atris, wiki, todo, flow]
---

> **Sister skill: /flow** — flow runs the same engine in reverse. flow chains forward from identity (who you are → today's next move). endgame chains backward from horizon (where you're going → today's next move). They meet at the same point: the next thing the agent should ship. Use both. Run flow at sunrise to set identity, run endgame at every TODO.md boundary to set horizon, and let /autopilot tick between them.

# /endgame

**Purpose:** help the human (or agent) reach their intent and goal **faster** by leveraging what the wiki already knows. Without endgame, they redo thinking. With endgame, they reach the next move in one pass — and write that move into TODO.md so the autopilot loop can pursue it without re-asking.

Most planning is forward-greedy: *what's the next ticket?* Endgame is backward: *what does winning look like, and what's the shortest path from here?*

> "You can't connect the dots looking forward; you can only connect them looking backward." — Steve Jobs

## Step 0 — CHECK FOR EXISTING ENDGAME FIRST

Before anything else, read `atris/TODO.md`. If it already has a `## Endgame` section AND uncompleted `[endgame]`-tagged tasks in `## Backlog`, **do not pick a new endgame**. Instead reply: "current endgame `<slug>` still active — N steps remaining. Run `/autopilot` to continue, or `force /endgame` to reset." Then exit.

This rule exists so the loop pursues the current horizon to completion instead of constantly repicking.

## Step 1 — READ THE INBOX, WIKI, LOGS

Before picking a new horizon, read what already exists. The wiki + logs are the user's paid-for memory; not using them means they're paying twice.

- `atris/lessons.md` — past surprises and failures the validator wrote down. Read this FIRST. Avoid horizons that hit the same rocks.
- `atris/wiki/STATUS.md` — current state, last loop findings, suggested next ingests
- `atris/wiki/index.md` — what pages already exist
- `atris/wiki/briefs/` — most recent cross-cutting brief pages (often already contain a horizon)
- `atris/MAP.md` — what code exists today
- `atris/TODO.md` — what's queued, what's done
- `atris/logs/YYYY/` — last 7-14 days of journals; scan `## Inbox` sections for unfulfilled ideas (these are user-seeded horizons)
- `atris/PERSONA.md` — current identity (paired with /flow's forward direction)
- `atris/business/<slug>/BUSINESS.md` if a business workspace

**Inbox items are the primary horizon source.** If recent journal `## Inbox` sections have unfulfilled ideas, pick the oldest one and run the three moves on it. Only fall back to reactive signals (wiki staleness, broken refs) if the inbox is empty.

If the horizon is genuinely unreadable from those sources, ask **1–3 sharp questions**. Never more. Never a wall of text.

## The three moves

1. **HORIZON** — One paragraph. What does the world look like when we win? Concrete. Falsifiable. Not a slogan.
2. **REVERSE PATH** — Chain backward from HORIZON. Last move before winning, the one before, etc. **Include eliminate steps** — what gets deleted on the way to the endgame, not just what gets added. Stop when you hit something doable this week. 5–7 links max.
3. **NEXT MOVE** — The first link in the chain. One concrete action, one session, no hedging.

> **v1.1.0 cut:** prior versions had two more moves — `IDENTITY` ("who are we when we've arrived") and `GAP` ("already true vs not yet"). Identity was philosophical overhead; GAP was just the diff between HORIZON and current state, which the wiki + MAP already give you. Three moves is enough. Less drift surface, faster ticks, fewer phrases for the validator to verify.

## Step 2 — WRITE TO TODO.md

After running the three moves, write the result to `atris/TODO.md`:

1. **Add a `## Endgame` section** (above `## Backlog`) with this exact shape:

```markdown
## Endgame

**Slug:** <kebab-case-slug>
**Picked:** YYYY-MM-DD HH:MM
**Horizon:** <one-line summary of HORIZON>
**Source:** <inbox-item | wiki-signal | user-prompt> (so we know where it came from)
```

2. **Add each REVERSE PATH step as a tagged backlog task** in `## Backlog`:

```markdown
- **T1:** <step 1 description> [endgame]
  **Verify:** <deterministic-check>
- **T2:** <step 2 description> [endgame]
  **Verify:** <deterministic-check>
- **T3:** <step 3 description> [endgame]
  **Verify:** <deterministic-check>
```

The tag must be exactly `[endgame]` (parser only matches `\w+`, no colons or hyphens). The slug lives in the section header.

3. **Always append an RSI audit as the final task:**

```markdown
- **TN:** RSI audit: read this endgame's halts, verify failures, and lessons. If the loop itself broke during this endgame (parser, reward, scorecard, verify wiring), fix it. If nothing broke, no-op. [endgame]
  **Verify:** npm test
```

This is non-negotiable. Every endgame ends by pointing the loop inward. The loop improves what it ships (RL) AND improves itself (RSI). Same chain, last task, always.

3. **Each task must include a `Verify:` line** with a deterministic check:
   - **Test command:** `npm test` or `npm run test:feature`
   - **Grep pattern:** `grep -q "pattern" file.js`
   - **File presence:** `test -f path/to/file.md`
   - **Exit code:** `node -e "process.exit(...)"` (or any shell command)

   The verify command must:
   - Complete in <30 seconds
   - Exit 0 on pass, non-zero on fail
   - Not require user input
   - Be runnable from project root

Use `T1`, `T2`, `T3` … as IDs (or `W1`/`E1`/etc per endgame domain). Single uppercase letter + digits, optional trailing lowercase letter (the parser was extended in commit `4db14d9` to accept `W3b`-style validator sub-task IDs).

4. **Append the full endgame to today's journal `## Notes`** so the reasoning is preserved:

```markdown
### Endgame picked — HH:MM PDT

slug: <slug>
source: <where>

HORIZON
  <one paragraph>

REVERSE PATH
  ENDGAME
    ← T5
    ← T4
    ← T3
    ← T2
    ← T1 (next move)

NEXT MOVE
  T1: <description>
  Verify: <check-command>
  Why this first: <one line>
```

This is the archive — once the endgame closes, future `/endgame` runs can read this to learn what worked.

## Step 3 — ARCHIVE PRIOR ENDGAME (if any)

If there was a `## Endgame` section in TODO.md before this run AND all its `[endgame]` tasks are done, append a closing entry to today's journal `## Notes`:

```markdown
### Endgame closed — HH:MM PDT

slug: <prior-slug>
shipped: N/N steps
commits: <list of commits since endgame was picked>
lessons: <one-line takeaway>
```

Then remove the old `## Endgame` section from TODO.md before writing the new one. Completed `[endgame]` tasks should already have moved to `## Completed` via the validator.

## Output shape (when called interactively)

When a human runs `/endgame` directly (not from a cron tick), show the three moves on screen first, ask one yes/no for confirmation, then write to TODO.md only after the human says go. When called from autopilot at a boundary, skip the confirmation — write straight to TODO.md and journal it.

```
HORIZON
  [one paragraph: concrete, falsifiable, not a slogan]

REVERSE PATH
  ENDGAME
    ← step N        (add or eliminate)
    ← step N-1
    ← ...
    ← step 1 (this week)

NEXT MOVE
  [one concrete action, doable in one session]
  Verify: [deterministic check — test, grep, file, exit code]
  Why this first: [one line]
```

## Rules

- **Step 0 first.** If a current endgame is still active, do not pick a new one. Continue, don't repick.
- **Read inbox + wiki first.** The whole point is leveraging what exists.
- **HORIZON before REVERSE PATH.** Vision before steps.
- **REVERSE PATH includes eliminate.** Half of strategy is removal. Forward-greedy planning never asks this. Endgame must.
- **The chain must terminate this week.** If it can't, the horizon is too far — pick a closer one and say so.
- **5–7 links max in the chain.** More than that = horizon is too vague.
- **Every task must have a Verify line.** Deterministic check (test, grep, file, exit code). Allows the validator to score the endgame autonomously.
- **Cite wiki pages** with `[[atris/wiki/...]]` refs.
- **Ask 1–3 questions max** if the horizon is unclear. Never a wall of text.
- **One chain, not three.** Pick the shortest defensible one.
- **No "we could also"** anywhere in NEXT MOVE. There is one move.
- **Reject mysticism.** Vision is necessary but not sufficient. The chain must be falsifiable and doable.
- **Tag format is `[endgame]` only** — no colons, no slugs in the tag. Slug lives in the section header.

## Phase 2 — agent runs this on itself

This skill is designed to be runnable by the agent on its own state, not just by humans. When `atris autopilot` finishes the last `[endgame]` task in the current horizon, the next tick's boundary check invokes `/endgame` against the new state, picks the next horizon from inbox/wiki, writes it to TODO.md, and queues the next move — without a human pulling the trigger.

## When to use vs other skills

| Skill | When |
|---|---|
| `autopilot` | Run one tick of the current endgame |
| `decide` | You have N options and need to pick |
| `improve` | You want to clean up drift |
| `wiki` | You want to capture knowledge |
| `loop` | You want the autopilot heartbeat scheduled |
| **`endgame`** | No current horizon, current one done, or work feels busy-but-pointless |

## Anti-patterns

- Skipping Step 0 (check for existing endgame). Repicking mid-pursuit kills compounding.
- Skipping Step 1 (read inbox + wiki). The skill is pointless without it.
- Walls of clarifying questions. Max 1–3.
- Listing 5 possible endgames. Pick one and commit.
- REVERSE PATH that's purely additive. Always include at least one eliminate.
- Chain longer than 7 links. Shorten the horizon.
- Three "next moves." There is one.
- Quoting goals from a deck. Read the wiki, look at reality.
- Tagging tasks with `[endgame:slug]` — parser only accepts `[\w+]`, will fail silently.
- Padding with IDENTITY or GAP sections — those were cut in v1.1.0 as autopilot overhead.

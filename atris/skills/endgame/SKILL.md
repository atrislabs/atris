---
name: endgame
description: "Fastest path from a vague goal to one concrete next move, powered by the wiki so the user never re-does work. Defines the win, names who you are when you've arrived, diffs what's already true vs not yet, chains backward to tomorrow. Use when a human (or agent) needs to compress intent into action without redoing thinking the wiki already holds. Triggers on: endgame, what's the last move, where are we heading, reverse engineer, work backward."
version: 0.2.0
tags: [planning, vision, reverse-engineer, atris, wiki]
---

# /endgame

**Purpose:** help the human (or agent) reach their intent and goal **faster** by leveraging what the wiki already knows. Without endgame, they redo thinking. With endgame, they reach the next move in one pass.

Most planning is forward-greedy: *what's the next ticket?* Endgame is backward: *what does winning look like, who are we when we've arrived, and what's the shortest path from here?*

> "You can't connect the dots looking forward; you can only connect them looking backward." — Steve Jobs

## Step 0 — READ THE WIKI FIRST

Before anything else, read what already exists. The wiki is the user's paid-for memory; not using it means they're paying twice.

- `atris/wiki/STATUS.md` — current state, last loop findings, suggested next ingests
- `atris/wiki/index.md` — what pages already exist
- `atris/wiki/syntheses/` — most recent synthesis pages (often already contain a horizon)
- `atris/MAP.md` — what code exists today
- `atris/TODO.md` — what's queued
- `atris/business/<slug>/BUSINESS.md` if a business workspace
- Most recent journal entries

If the horizon is genuinely unreadable from those sources, ask **1–3 sharp questions**. Never more. Never a wall of text.

## The five moves

1. **HORIZON** — One paragraph. What does the world look like when we win? Concrete. Falsifiable. Not a slogan.
2. **IDENTITY** — Who are we when we've arrived? Not what we've built — who we *are*. State, not destination. This shapes today's behavior more than the steps do.
3. **GAP** — Two columns: **already true** (fuel) and **not yet** (work). Cite wiki pages. Never deficit-only.
4. **REVERSE PATH** — Chain backward from HORIZON. Last move before winning, the one before, etc. **Include eliminate steps** — what gets deleted on the way to the endgame, not just what gets added. Stop when you hit something doable this week.
5. **NEXT** — The first link in the chain. One concrete action, one session, no hedging.

## Output shape

```
HORIZON
  [one paragraph: concrete, falsifiable, not a slogan]

IDENTITY
  [one or two sentences: who are we when we've arrived?]

GAP
  ALREADY TRUE
    - [fuel — what the wiki/code already gives us]
    - ...
  NOT YET
    - [biggest missing piece]
    - ...

REVERSE PATH
  ENDGAME
    ← step N        (add or eliminate)
    ← step N-1
    ← ...
    ← step 1 (this week)

NEXT MOVE
  [one concrete action, doable in one session]
  Why this first: [one line]
```

## Rules

- **Read the wiki first.** Step 0 is non-negotiable. The whole point is leveraging what exists.
- **HORIZON before GAP.** Vision before deficit. Never invert.
- **IDENTITY before GAP.** State before steps. Acting *from* the endgame beats acting *toward* it.
- **GAP has two columns.** Pure deficit framing makes you tired. Already-true is fuel.
- **REVERSE PATH includes eliminate.** Half of strategy is removal. Forward-greedy planning never asks this. Endgame must.
- **The chain must terminate this week.** If it can't, the horizon is too far — pick a closer one and say so.
- **5–7 links max in the chain.** More than that = horizon is too vague.
- **Cite wiki pages** with `[[atris/wiki/...]]` refs.
- **Ask 1–3 questions max** if the horizon is unclear. Never a wall of text.
- **One chain, not three.** Pick the shortest defensible one.
- **No "we could also"** anywhere in NEXT MOVE. There is one move.
- **Reject mysticism.** Vision is necessary but not sufficient. The chain must be falsifiable and doable.

## Phase 2 — agent runs this on itself

This skill is designed to be runnable by the agent on its own state, not just by humans. When `atris autopilot` finishes a cycle and the wiki updates, the agent should be able to call `/endgame` against the new state, pick the next horizon, and queue the next move — without a human pulling the trigger. The day the agent endgames AND autopilots autonomously, atris-cli closes the loop on itself.

## When to use vs other skills

| Skill | When |
|---|---|
| `autopilot` | You know the next task, want it executed |
| `decide` | You have N options and need to pick |
| `improve` | You want to clean up drift |
| `wiki` | You want to capture knowledge |
| `loop` | You want the wiki kept fresh |
| **`endgame`** | You don't know what you're building toward, or work feels busy-but-pointless, or you want the shortest path from intent to action |

## Anti-patterns

- Skipping Step 0 (read the wiki). The skill is pointless without it.
- Walls of clarifying questions. Max 1–3.
- Skipping IDENTITY and going straight to GAP. The "who" shapes the "what."
- Listing 5 possible endgames. Pick one and commit.
- GAP that's only deficit. Always two columns.
- REVERSE PATH that's purely additive. Always include at least one eliminate.
- Chain longer than 7 links. Shorten the horizon.
- Three "next moves." There is one.
- Quoting goals from a deck. Read the wiki, look at reality.

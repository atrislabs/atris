# /endgame

Reverse engineer success. Work backward from done. Every step verifiable.

If you can define "done" with precision, the path backward writes itself and /autopilot executes it mechanically.

## Trigger

- "endgame"
- "what's the last move"
- "where are we heading"
- "reverse engineer {goal}"
- "set up the horizon"
- "pick the next endgame"

## Docs to Load

```
1. atris/TODO.md                       — current endgame + backlog + in-progress
2. atris/MAP.md                        — what actually exists (file:line truth)
3. atris/logs/YYYY/YYYY-MM-DD.md       — recent work (what just shipped)
4. atris/lessons.md                    — what went wrong before (if exists)
5. atris/features/                     — scan for overlap before creating new work
```

## The Loop

```
1. SCOUT
   - Read TODO.md: is the current endgame done? stale? misaligned?
   - Read last 3 journal entries: what momentum exists?
   - Read MAP.md: what's the actual state of the codebase?
   - Read lessons.md: what patterns burned us?
   - OUTPUT: "Here's what I see" — 3-5 bullets, no fluff

2. GAP ANALYSIS (the BS check BEFORE you pick)
   - For every capability the horizon mentions:
     grep/test the codebase. Does it exist or not?
   - Split into two columns:
     SHIPPED (grep proves it)  |  NOT YET (grep fails)
   - Kill any task that's already done
   - If the current endgame is >50% shipped, it's time for a new one
   - OUTPUT: the real delta, grounded in code

3. DEFINE DONE
   - One sentence: what is true when this endgame is complete?
   - NOT aspirational ("any software spawns on demand")
   - YES verifiable ("all apps execute through BlockExecutor,
     fork creates independent block copies,
     external origins render app blocks via embed API")
   - The sentence must be falsifiable with grep/curl/test commands
   - OUTPUT: "Done when: {sentence}"

4. REVERSE PATH
   - Start from the done-when sentence
   - Work backward: what's the last thing that has to be true?
   - Then: what has to be true before that?
   - Keep going until you hit current state
   - Each step becomes a task
   - OUTPUT: numbered task list, latest step first, then reversed

5. TASK DISCIPLINE
   For EACH task in the reverse path:
   - One sentence description (what, not how)
   - Tag: [explore] or [execute]
   - Exit condition: one sentence, "done when"
   - Verify command: a shell command that returns pass/fail
   - Sequence: which task(s) must complete first
   - RUN the verify command NOW for tasks you suspect are done
     If it passes → task is already done, delete it

6. VALIDATE THE PLAN
   - Can /autopilot pick up T1 and execute without asking a single question?
   - Does every verify command actually test the exit condition?
   - Is the curriculum ordered? (early tasks teach, later tasks build)
   - Are there fewer than 7 tasks? (more = too vague, break the endgame)
   - Does the horizon have a slug, picked date, and source?

7. WRITE
   - Update TODO.md ## Endgame section
   - Tag backlog tasks with [endgame]
   - Log to today's journal under ## Notes
   - If replacing a completed endgame, move old horizon to ## Completed
```

## TODO.md Format

```markdown
## Endgame

**Slug:** {kebab-case-name}
**Picked:** {YYYY-MM-DD HH:MM}
**Done when:** {one falsifiable sentence}
**Source:** {what triggered this — user prompt, lesson, inbox item, boundary}

## Backlog

- **T{n}:** {one sentence} [endgame] [explore|execute]
  **Exit:** {done when sentence}
  **Verify:** `{shell command that returns 0 on success}`
  **After:** {T{n-1} or "none"}
```

## The Contract with /autopilot

Endgame writes. Autopilot reads. The contract:

1. Every [endgame] task in backlog is ready to execute in sequence
2. Every task has a verify command that autopilot can run
3. No task requires asking the user for clarification
4. The verify command is the ONLY judge of completion — not vibes, not "looks right"
5. When the last [endgame] task passes verify, the endgame is done
6. Autopilot calls /endgame at the boundary to pick the next horizon

## Anti-Patterns

```
BAD:  "Build marketplace for blocks"
      (what does done look like? no verify command possible)

GOOD: "Add POST /api/blocks/{id}/fork that deep-clones block + children"
      Exit: forked block has different ID, own children, no shared refs
      Verify: `curl -s POST .../fork | jq '.id != "{original}"'`

BAD:  Horizon says "any software spawns on demand"
      (half of this is already shipped — gap analysis failure)

GOOD: Horizon says "all app execution routes through BlockExecutor"
      (grep "quick_chat" returns 0 hits — falsifiable)

BAD:  7+ tasks in one endgame
      (too vague — you're describing a quarter, not a horizon)

GOOD: 3-5 tasks, each unlocks the next, done in days not months
```

## Boundary Detection

An endgame is DONE when:
- All [endgame] tasks pass their verify commands
- OR the endgame is stale (>14 days, world changed)
- OR >50% of tasks were already done at gap analysis (bad endgame, rewrite)

At boundary, /endgame runs again automatically:
Scout → Gap → Define Done → Reverse Path → Write

## Example

```
User: /endgame

Claude:
1. SCOUT
   - Current endgame "apps-blocks-convergence" picked 2026-04-13
   - Last 3 days: shipped block executor, auto-compose, remix endpoint
   - MAP.md shows blocks_router, app_service.remix_app, embed_router

2. GAP ANALYSIS
   SHIPPED                          NOT YET
   - Block CRUD + execution         - quick_chat still in app_execution
   - App → block pipeline routing   - Fork shares block refs (shallow)
   - Remix/publish/discover         - Embed only for agents, not apps
   - Auto-compose from goals

3. DEFINE DONE
   "Done when: app_execution_service has zero quick_chat calls,
    app fork creates independent block copies with unique IDs,
    and embed_router serves app blocks to external origins."

4. REVERSE PATH (backward)
   5. Embed serves app blocks → needs apps on blocks (3) + portable forks (4)
   4. Fork deep-clones blocks → needs all apps on blocks (3)
   3. Kill quick_chat → needs block path working for all app types

   Reversed: 3 → 4 → 5

5. TASKS
   T3: Remove quick_chat fallback from AppExecutionService [execute]
   Exit: no quick_chat calls in app execution path
   Verify: `grep -c "quick_chat" backend/services/app_execution_service.py | grep "^0$"`
   After: none

   T4: Deep-clone block tree on app fork [execute]
   Exit: forked app's block IDs are all unique, no shared refs
   Verify: `python -c "...fork test returns unique IDs..."`
   After: T3

   T5: Add app block embed endpoint [execute]
   Exit: external origin can render app block via /api/embed/app/{id}
   Verify: `curl -s localhost:8000/api/embed/app/{id}/config | jq '.block_id'`
   After: T4

6. VALIDATE
   - Can autopilot start T3 without questions? Yes — grep, delete, test.
   - Verify commands test the exit conditions? Yes.
   - Sequence correct? Yes — 3 before 4 before 5.
   - Under 7 tasks? Yes — 3 tasks.

7. WRITE → TODO.md updated
```

## Success

```
Input:  project state + vague direction
Output: falsifiable horizon + sequenced tasks + verify commands

The path from here to done is mechanical.
/autopilot executes it tick by tick.
No ambiguity. No vibes. No "looks right."
```

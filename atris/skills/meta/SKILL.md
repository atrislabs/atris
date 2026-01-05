---
name: meta
description: Metacognition skill for AI agents. Use when starting work, feeling stuck, output feels off, or before complex tasks. Teaches how to think about thinking.
---

# Meta Skill

How to be an effective agent. Load this when you need to check yourself.

## When to activate

- Starting a new session (orientation)
- Feeling stuck or uncertain
- Output feels sloppy or generic
- Complex task ahead
- After a mistake

## Context awareness

1. **MAP first** - Read `atris/MAP.md` before any search. It's the index.
2. **Journal context** - Check today's log for recent work, patterns, blockers.
3. **LESSONS.md** - What failed before? Don't repeat.
4. **Skill routing** - Frontend? Load `design`. Backend? Load `backend`. Writing? Load `writing`.

## Pace control

| Signal | Action |
|--------|--------|
| Simple task, clear path | Execute fast |
| Complex task, multiple approaches | Slow down, plan first |
| Uncertain about intent | Ask ONE question |
| Output feels off | Pause, re-read context |
| Stuck > 2 attempts | Escalate, don't spiral |

## Self-correction triggers

Stop and reassess when:
- You're about to search without checking MAP
- You're writing code during PLAN phase
- You're adding features not requested
- You're explaining instead of doing
- You've used words like "robust", "comprehensive", "streamlined"

## Memory leverage

Before acting:
1. Check `atris/policies/LESSONS.md` - short lessons from past mistakes
2. Check `atris/features/` - prior art for similar work
3. Check journal history - `grep -i "<keyword>" atris/logs/**/*.md`

## Skill composition

You can stack skills:
- `meta` + `design` = thoughtful frontend work
- `meta` + `backend` = careful API design
- `meta` + `writing` = deliberate prose

Meta is the foundation. Domain skills are the specialization.

## The loop

```
Orient (read context)
    ↓
Decide (which skill? what pace?)
    ↓
Act (execute with focus)
    ↓
Check (output match intent?)
    ↓
Learn (add to LESSONS if miss)
```

## Anti-patterns

- Grepping before MAP check
- Coding during planning
- Adding unrequested features
- Verbose explanations
- Guessing instead of asking
- Repeating past mistakes
- Creating skill without symlinking to .claude/skills/ (won't load mid-session)

## Skill evolution

Skills improve from your mistakes:
1. After REVIEW, log learnings to `LESSONS.md` (format: `date | skill | lesson`)
2. Repeated lessons (2-3x) get promoted into the relevant skill
3. Next agent loads the improved skill

You're training future agents. Leave the codebase smarter than you found it.

## One-liner

Think before you act. Check yourself. Use the system.

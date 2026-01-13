---
name: autopilot
description: PRD-driven autonomous execution - give it a task, it loops until done
triggers: [autopilot, autonomous, "get it done", "finish this", "ship it"]
---

# Autopilot Skill

Autonomous task execution. Plan → Do → Review loop until acceptance criteria pass.

## When to Use

- User says "get this done" or "ship it"
- User describes a feature/bug and wants hands-off execution
- Any task that can be validated with acceptance criteria

## Process

```
┌───────────────────────────────────────────────────────┐
│  INPUT: "Add dark mode toggle"                        │
│                                                       │
│  1. GENERATE PRD                                      │
│     - Type: feature or bug (auto-detect)              │
│     - Acceptance criteria (testable conditions)       │
│     - Priority: 1 (single story)                      │
│                                                       │
│  2. LOOP (max 5 iterations)                           │
│     ┌──────────────────────────────────────┐          │
│     │ PLAN: Navigator creates tasks        │          │
│     │   - Read MAP.md for file locations   │          │
│     │   - ASCII diagram of approach        │          │
│     │   - Add tasks to TODO.md             │          │
│     │   - Signal: [PLAN_COMPLETE]          │          │
│     ├──────────────────────────────────────┤          │
│     │ DO: Executor builds                  │          │
│     │   - Implement each task              │          │
│     │   - Verify changes work              │          │
│     │   - Commit changes                   │          │
│     │   - Signal: [DO_COMPLETE]            │          │
│     ├──────────────────────────────────────┤          │
│     │ REVIEW: Validator checks             │          │
│     │   - Check acceptance criteria        │          │
│     │   - If fail: [REVIEW_FAILED] reason  │          │
│     │   - If pass: <promise>COMPLETE</promise>        │
│     └──────────────────────────────────────┘          │
│                                                       │
│  3. OUTPUT                                            │
│     - prd.json: PRD with passes: true                 │
│     - progress.txt: Execution log                     │
│     - Journal: Completion logged                      │
└───────────────────────────────────────────────────────┘
```

## Acceptance Criteria Templates

**Feature:**
- Feature implemented and working as described
- Tests pass (if test suite exists)
- Build passes
- Code follows project patterns (check MAP.md)

**Bug:**
- Bug is fixed and no longer reproducible
- Regression test added (if applicable)
- Build passes
- No new bugs introduced

## Commands

```bash
# With description
atris autopilot "Add dark mode toggle"

# Bug fix
atris autopilot --bug "Login fails on Safari"

# From TODO.md backlog
atris autopilot --from-todo

# With options
atris autopilot "Add feature" --iterations=3 --verbose
```

## Stop Conditions

1. `<promise>COMPLETE</promise>` — All acceptance criteria met
2. Max iterations reached (default: 5)
3. Error that can't be recovered

## Rules

- ONE task at a time
- Verify before marking passes: true
- Minimal changes only
- Check MAP.md before touching code
- Log to journal when complete

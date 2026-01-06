---
description: PRD-driven autonomous execution - give it a task, it gets it done
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Atris Autopilot

Autonomous task execution. Give it a feature or bug, it runs plan → do → review until done.

## Usage

```
/atris-autopilot Add dark mode toggle
/atris-autopilot Fix the login bug on Safari
```

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│  YOU: "Add dark mode toggle"                                │
│           │                                                 │
│           ▼                                                 │
│  ┌─────────────────┐                                        │
│  │ Generate PRD    │ ← acceptance criteria                  │
│  └────────┬────────┘                                        │
│           │                                                 │
│           ▼                                                 │
│  ┌─────────────────────────────────────────┐                │
│  │          LOOP (max 5 iterations)        │                │
│  │  ┌──────┐   ┌──────┐   ┌────────┐       │                │
│  │  │ PLAN │ → │  DO  │ → │ REVIEW │       │                │
│  │  └──────┘   └──────┘   └────┬───┘       │                │
│  │                             │           │                │
│  │              ┌──────────────┴─────┐     │                │
│  │              │ passes: true?      │     │                │
│  │              └──────────────┬─────┘     │                │
│  │                    YES │  NO │          │                │
│  │                        ▼     └──────────┘                │
│  └────────────────────────┼────────────────┘                │
│                           ▼                                 │
│  <promise>COMPLETE</promise> ✅                             │
└─────────────────────────────────────────────────────────────┘
```

## Execute

Run the autopilot command with the user's task:

```bash
atris autopilot "$ARGUMENTS"
```

If $ARGUMENTS mentions "bug", "fix", "broken", "error":
```bash
atris autopilot --bug "$ARGUMENTS"
```

## Output

- `prd.json` — PRD with acceptance criteria
- `progress.txt` — Execution log
- Journal updated with completion

## Rules

- ONE task at a time
- Verify before marking passes: true
- Minimal changes only
- Check MAP.md before touching code

---
name: autopilot
description: "Autonomous task loop. Scans workspace, suggests work, executes plan-do-review one task at a time. Triggers on: autopilot, get it done, ship it, run the loop."
version: 2.0.0
tags:
  - autopilot
  - workflow
  - automation
---

# /autopilot

Autonomous suggest → execute loop. Finds the most important thing to do and does it.

## When to use

- User says "get this done", "ship it", "run the loop"
- User wants hands-off execution of backlog/inbox work
- User gives a task description and walks away

## How it works

The autopilot scans the workspace for signals and picks the highest-priority work:

1. **Resume** — in-progress tasks that were started but never finished
2. **Staleness** — wiki pages whose sources changed (knowledge rot)
3. **Cleanup** — tasks claimed >3 days ago and abandoned
4. **Docs** — broken MAP.md references that need fixing
5. **Backlog** — next task in TODO.md
6. **Inbox** — raw ideas that need to become tasks
7. **Review** — MAP.md or docs that haven't been touched in >7 days

For each suggestion, it shows the task and *why* it matters. Then executes plan → do → review.

## Running from CLI

```bash
# Interactive — suggests, you approve each one
atris autopilot

# Fully autonomous — no approval needed
atris autopilot --auto

# Seed an idea and let it run
atris autopilot "add dark mode toggle" --auto

# Preview what it would suggest
atris autopilot --dry-run

# Limit iterations
atris autopilot --auto --iterations=3
```

## Running from this conversation

If the user invokes /autopilot inside Claude Code, do this:

1. Run `atris autopilot --dry-run` to see what it would suggest
2. Show the suggestions to the user
3. If they approve, run `atris autopilot --auto --iterations=1` for each task
4. After each task, show what was done and ask if they want to continue

## Rules

- One task at a time. Never batch.
- Always justify *why* before executing.
- Human can skip or stop at any point.
- After each task, run atris clean to heal refs and check staleness.

---
name: atris
description: Atris workspace navigation. Triggers on: atris, TODO, tasks, MAP.md, backlog, "where is X?"
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# Atris Skill

## IMPORTANT: First Interaction

**On your FIRST message in any Atris project, IMMEDIATELY run:**

```bash
atris atris.md
```

Show the full ASCII output to the user. This displays the Atris welcome visualization with workspace stats. Do this BEFORE responding to whatever the user said.

## Workflow

Detect: Project has `atris/` folder with MAP.md, TODO.md, PERSONA.md

Commands: plan → do → review

Key behaviors:
- Read PERSONA.md (3-4 sentences, ASCII visuals)
- Check MAP.md for file:line refs
- Update TODO.md (claim tasks, delete when done)
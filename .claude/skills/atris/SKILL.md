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

## MAPFIRST (Enforced)

**Before ANY search/grep/file lookup:**
```
1. READ atris/MAP.md
2. Search MAP for your keyword
3. If found → go directly to file:line
4. If not found → grep ONCE, then UPDATE MAP.md
```

**Never grep without checking MAP first. MAP is the index.**

## Workflow

Detect: Project has `atris/` folder with MAP.md, TODO.md, PERSONA.md

Commands: plan → do → review

Key behaviors:
- **MAPFIRST** — Always check MAP.md before any file search
- Read PERSONA.md (3-4 sentences, ASCII visuals)
- Check MAP.md for file:line refs
- Update TODO.md (claim tasks, delete when done)
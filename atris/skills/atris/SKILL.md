---
name: atris
description: "Atris workspace navigation for atris repos, TODO files, tasks, MAP.md, backlog, and where-is-X questions. Use when navigating an Atris workspace, finding files via MAP.md, or checking task state."
version: 1.0.0
tags:
  - atris
  - navigation
  - workspace
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
- Use `atris task` for claims, proof, ready, and accept
- Use functional/feature members as task owners; record engines only as `executed_by`
- Treat TODO.md as a rendered view; regenerate it instead of hand-editing tasks

## Steps

1. Run `atris atris.md` on first interaction to show workspace status
2. Read `atris/MAP.md` before any file search to find file:line refs
3. Run `atris task list` or `atris task next` to find current work
4. Claim tasks with `atris task claim <id> --as <functional-member>`
5. Move completed work to review with `atris task ready <id> --proof "..."`

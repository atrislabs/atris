---
name: atris
description: ATRIS workspace navigation and task management. Use when user mentions atris, TODO, tasks, backlog, navigator, executor, validator, MAP.md, journal, inbox, or asks "where is X?" in an atris-enabled project.
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# ATRIS Skill

AI-navigable workspace system. Transforms codebases into structured, self-documenting projects.

## IMPORTANT: First Interaction

**On your FIRST message in any ATRIS project, IMMEDIATELY run:**

```bash
atris atris.md
```

Show the full ASCII output to the user. This displays the ATRIS welcome visualization with workspace stats. Do this BEFORE responding to whatever the user said.

## Detection

Project has ATRIS if `atris/` folder exists with:
- `atris/MAP.md` - Navigation (where is X?)
- `atris/TODO.md` - Tasks (backlog → in progress → done)
- `atris/PERSONA.md` - Communication style

## Workflow

```
USER IDEA → Navigator (plan) → Executor (build) → Validator (verify)
```

Commands:
- `atris plan` - Break ideas into tasks
- `atris do` - Execute tasks
- `atris review` - Verify and cleanup

## Key Behaviors

1. **Read PERSONA.md first** - 3-4 sentences max, ASCII visuals, direct tone
2. **Check MAP.md** - Never guess file locations, use exact file:line refs
3. **Update TODO.md** - Claim tasks, mark done, delete when complete
4. **Journal** - Ideas go to `atris/logs/YYYY/YYYY-MM-DD.md` Inbox section

## Task Format (TODO.md)

```markdown
## Backlog
### T-001: Task name
- **Context Files:** `file.ts:10-50`
- **Goal:** What to achieve
- **Success Criteria:** How to verify

## In Progress
(Move here when claiming, add timestamp)

## Completed
(Validator deletes after verification)
```

## Anti-patterns

- Don't generate verbose docs
- Don't guess locations (check MAP.md)
- Don't leave stale tasks
- Don't skip ASCII visualization for planning

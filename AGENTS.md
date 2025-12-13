# AGENTS.md — Universal Agent Instructions

> Works with: Claude Code, Cursor, Codex, Windsurf, and any AI coding agent.

## Quick Start

```bash
atris
```

Run this first. Follow the output.

## Core Files

| File | Purpose |
|------|---------|
| `atris/PERSONA.md` | Communication style (read first) |
| `atris/TODO.md` | Current tasks |
| `atris/MAP.md` | Navigation (where is X?) |

## Workflow

```
PLAN  → atris plan   (break ideas into tasks)
BUILD → atris do     (execute tasks)
CHECK → atris review (verify + cleanup)
```

## Rules

- [ ] 3-4 sentences max per response
- [ ] Use ASCII visuals for planning
- [ ] Check MAP.md before touching code
- [ ] Claim tasks in TODO.md before working
- [ ] Delete tasks when done

## Anti-patterns

- Don't explore codebase manually (use MAP.md)
- Don't skip visualization step
- Don't leave stale tasks
- Don't write verbose docs

---

**Protocol:** See `atris/atris.md` for full spec.
---
description: Activate Atris context - loads TODO.md, journal, and persona
allowed-tools: Read, Bash, Glob, Grep
---

# Atris Activate

Load workspace context for AI-navigable development.

## Auto-load these files:

1. **Persona** (communication style): @atris/PERSONA.md
2. **Tasks** (current work): @atris/TODO.md
3. **Navigation** (where is X?): @atris/MAP.md

## Check today's journal:

!`ls -la atris/logs/2025/ 2>/dev/null | tail -3`

## Your workflow:

```
PLAN  → atris plan   (navigator creates tasks)
BUILD → atris do     (executor builds)
CHECK → atris review (validator verifies)
```

## Rules:

- 3-4 sentences max, use ASCII visuals
- Check MAP.md before touching code
- Delete tasks from TODO.md when done
- Fast, focused, ruthlessly efficient

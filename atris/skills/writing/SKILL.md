---
name: writing
description: Essay writing skill. Triggers on: essay, draft, write, outline
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Writing Skill

Structured writing process with approval gates.

## Process

```
INBOX → OUTLINE → PANEL → WRITE → PASSES
```

1. **Inbox** — Capture raw ideas, no structure
2. **Outline** — Topic skeleton with evidence underneath
3. **Panel** — AI pokes holes, human approves
4. **Write** — Section by section, approval each step
5. **Passes** — Argument (AI), out loud (human), sanity (both)

## Key Rules

- No one-shotting drafts
- Thinking time between sessions
- AI structures and polishes, human provides voice
- Review against `atris/policies/writing.md`

## Atris Commands

```bash
atris review     # validate against writing policy
```

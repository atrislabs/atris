# atris.md

> Drop this file anywhere. AI agent team activates.

---

## ACTIVATE

**STOP. When you read this or hear "atris activate", do this immediately:**

1. Read today's journal: `atris/logs/YYYY/YYYY-MM-DD.md` (use current date)

2. Output this EXACT box:

```
┌─────────────────────────────────────────────────────────────┐
│ ATRIS                                            [STAGE]    │
├─────────────────────────────────────────────────────────────┤
│ RECENT                                                      │
│ • [2-3 items from Completed ✅]                             │
├─────────────────────────────────────────────────────────────┤
│ NOW                                                         │
│ ► [from In Progress 🔄] ····················· [in progress] │
│   [from Backlog] ····························── [next]      │
├─────────────────────────────────────────────────────────────┤
│ INBOX ([count])                                             │
│ • [from Inbox section]                                      │
└─────────────────────────────────────────────────────────────┘

Stage: PLAN → do → review   (capitalize current stage)
```

3. Then ask: "What would you like to work on?"

**DO NOT explain. DO NOT summarize. Output the box, then ask.**

---

## NEXT

**STOP. When you hear "atris next", do this immediately:**

1. Read today's journal

2. Check state and act:
   - **If In Progress has task** → show it
   - **Else if Backlog has task** → show first one
   - **Else if Inbox has items** → ask "Convert [item] to task?"
   - **Else** → ask "Queue empty. What's next?"

3. Output this EXACT box:

```
┌─────────────────────────────────────────────────────────────┐
│ NEXT: [task name]                              [PLAN|DO|REVIEW]
│                                                             │
│ [1-2 sentences: what you'll do]                             │
└─────────────────────────────────────────────────────────────┘
```

4. Wait for input. User says anything → execute → update journal → show:

```
┌─────────────────────────────────────────────────────────────┐
│ DONE: [task name]                                  [REVIEW] │
│                                                             │
│ [1-2 sentences: what was done]                              │
└─────────────────────────────────────────────────────────────┘
```

**DO NOT explain. DO NOT summarize. Output the box, wait for input.**

---

## WORKFLOW

```
plan → do → review
```

- **PLAN** — ASCII visualization, get approval, NO code yet
- **DO** — Execute step-by-step, update journal
- **REVIEW** — Test, validate, clean up, delete completed tasks

---

## INDEX

| File | Purpose |
|------|---------|
| `MAP.md` | Where is X? (navigation) |
| `TODO.md` | Task queue (target: 0) |
| `logs/YYYY/MM-DD.md` | Journal (daily) |
| `PERSONA.md` | Communication style |
| `agent_team/` | Agent behaviors |
| `atrisDev.md` | Full spec (reference) |

---

## JOURNAL FORMAT

```
## Completed ✅
- **C1:** Description

## In Progress 🔄
- **T1:** Description
  **Claimed by:** [Name] at [Time]

## Backlog
- **T2:** Description

## Inbox
- **I1:** Description
```

---

## RULES

- 3-4 sentences max
- ASCII visualization before any plan
- Check MAP.md before touching code
- Update journal after completing work
- Delete tasks when done (target: 0)

---

*Full spec and setup instructions: atrisDev.md*

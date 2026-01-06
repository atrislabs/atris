# atris.md

> Drop this file anywhere. AI agent team activates.

---

## ACTIVATE

**STOP. When you read this or hear "atris activate", do this immediately:**

1. Load context (ONE time, remember for session):
   - `atris/logs/YYYY/YYYY-MM-DD.md` (today's journal)
   - `atris/MAP.md` (navigation overview)
   - `atris/team/*.md` (all agent specs)

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

2. Check state and progress through stages:

   **No task in progress?**
   - If Backlog has task → move to In Progress, stage = PLAN
   - Else if Inbox has items → ask "Convert [item] to task?"
   - Else → go to BRAINSTORM

   **Task in progress?** Progress to next stage:
   - **PLAN** → Show ASCII plan, wait for approval → next stage = DO
   - **DO** → Execute the work → next stage = REVIEW
   - **REVIEW** → Run validator checks (test, verify, quality check)
     - If passes → move to Completed, show DONE
     - If fails → show issues, stay in DO

3. Output this EXACT box:

```
┌─────────────────────────────────────────────────────────────┐
│ NEXT: [task name]                              [PLAN|DO|REVIEW]
│                                                             │
│ [1-2 sentences: what you'll do in this stage]               │
└─────────────────────────────────────────────────────────────┘
```

4. Wait for input. User says anything → execute current stage → update journal.

5. After REVIEW passes, show:

```
┌─────────────────────────────────────────────────────────────┐
│ DONE: [task name]                                   [✓ REVIEWED] │
│                                                             │
│ [1-2 sentences: what was done + review result]              │
└─────────────────────────────────────────────────────────────┘
```

**Every task goes through PLAN → DO → REVIEW. No shortcuts.**

---

## WORKFLOW

```
plan → do → review
```

- **PLAN** — ASCII visualization, get approval, NO code yet
- **DO** — Execute step-by-step, update journal
- **REVIEW** — Test, validate, clean up, delete completed tasks

---

## AGENTS

| Command | Agent | Guardrail |
|---------|-------|-----------|
| `atris plan` | navigator | Plans only, NO code |
| `atris do` | executor | Builds only, NO unplanned work |
| `atris review` | validator | Checks only, NO new features |
| `atris brainstorm` | brainstormer | Ideas only, NO code |

`atris next` = auto-selects agent based on journal state

Specs loaded at activate from `team/*.md`

---

## BRAINSTORM

**When queue empty (no backlog, no inbox):**

```
┌─────────────────────────────────────────────────────────────┐
│ BRAINSTORM                                           [PLAN] │
├─────────────────────────────────────────────────────────────┤
│ [1 sentence: what this project is]                          │
│                                                             │
│ Ideas:                                                      │
│ 1. [suggestion based on MAP.md]                             │
│ 2. [suggestion based on journal patterns]                   │
│ 3. [suggestion based on product gaps]                       │
├─────────────────────────────────────────────────────────────┤
│ Pick one, remix, or "something else"                        │
└─────────────────────────────────────────────────────────────┘
```

**NO extra reads. Use loaded context. 3 ideas max.**

---

## INDEX

| File | Purpose |
|------|---------|
| `MAP.md` | Where is X? (navigation) |
| `TODO.md` | Task queue (target: 0) |
| `logs/YYYY/MM-DD.md` | Journal (daily) |
| `PERSONA.md` | Communication style |
| `team/` | Agent behaviors |
| `atrisDev.md` | Full spec (reference) |

---

## JOURNAL FORMAT

```
## Completed ✅
- **C1:** Description [✓ REVIEWED]

## In Progress 🔄
- **T1:** Description
  **Stage:** PLAN | DO | REVIEW
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

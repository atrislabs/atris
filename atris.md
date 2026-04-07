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
scout → plan → do → review
```

- **SCOUT** — Read relevant files first. Understand before you act. Report what you found.
- **PLAN** — ASCII visualization, get approval, NO code yet
- **DO** — Execute step-by-step, update journal
- **REVIEW** — Test, validate, clean up, delete completed tasks

---

## TASK RULES

Every task must follow these rules. No exceptions.

**One job per task.** If a task touches more than 2-3 files, break it down. If you can't describe "done" in one sentence, it's too big.

**Clear exit condition.** Every task states what "done" looks like. Not "improve auth" — instead: "Add session check to upload handler. Done when: unauthenticated requests return 401 and test passes."

**Tag every task:**
- `[explore]` — Ambiguous. Needs reading, research, judgment. Output is understanding.
- `[execute]` — Precise. Route is clear. Just do it. Output is code or artifact.

**Explore before execute.** When starting a new area of work, the first tasks should be `[explore]`. Read the files. Map the space. Report what you found. Then plan `[execute]` tasks based on what you learned.

**Sequence matters.** Order tasks so each one builds context for the next. Early tasks should teach you about the problem. Later tasks use that knowledge.

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

## PERSISTENCE

Context window = cache. Disk = truth. Route discoveries as they happen.

| You discover...     | Write to...          | Format               |
|---------------------|----------------------|----------------------|
| Code location       | MAP.md               | file:line reference  |
| New task            | TODO.md              | Task + exit condition |
| Decision / tradeoff | Journal → Notes      | Timestamped line     |
| Something learned   | lessons.md           | One-line lesson      |
| Work finished       | Journal → Completed  | C#: description      |
| Source changed       | Re-check referencing pages | Frontmatter: last_compiled |

Don't batch. Don't wait for session end. Nothing important should live only in-context.

---

## KNOWLEDGE COMPILATION

The workspace is a knowledge compiler. Raw sources in, structured understanding out.

**Every markdown page that summarizes or references other files MUST have frontmatter:**

```yaml
---
last_compiled: YYYY-MM-DD
sources:
  - path/to/source1
  - path/to/source2
---
```

**Staleness rule:** If any source file was modified after `last_compiled`, the page is stale. On review, re-read the source and update the page. Update `last_compiled` when done.

**What counts as a source:** Any file a page summarizes, references, or draws conclusions from. Code files for MAP.md. Documents for wiki pages. Meeting notes for decision pages.

**Compounding:** When you answer a question that required synthesis across multiple pages, file the answer back as a new page (or update an existing one). Explorations accumulate — they don't disappear.

**Activation:** On session start, if `atris/wiki/STATUS.md` exists, read it with the journal and MAP so the current wiki state compounds into the next plan.

**Linting:** During `atris review`, check for:
- Stale pages (source newer than last_compiled)
- Orphan pages (no inbound references)
- Contradictions between pages
- Concepts mentioned but lacking their own page

---

## RULES

- 3-4 sentences max
- ASCII visualization before any plan
- Check MAP.md before touching code
- Update journal after completing work
- Delete tasks when done (target: 0)
- Persist as you go (see PERSISTENCE)
- After any file change, flag wiki pages that reference it as stale

---

*Full spec and setup instructions: atrisDev.md*

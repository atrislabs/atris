# Atris Boot Protocol — {{name}}

You are operating in the **{{name}}** Atris workspace.

## ON SESSION START

1. Read `atris/MAP.md` for navigation
2. Read `.atris/state/tasks.projection.json` if present; otherwise read `atris/TODO.md`
3. Read today's journal at `atris/logs/YYYY/YYYY-MM-DD.md`
4. Acknowledge what you have loaded, ask what to work on

## WORKFLOW

```
PLAN → DO → REVIEW
```

- **PLAN:** Read context, propose approach as ASCII visualization. Stop. Wait for approval.
- **DO:** Execute step-by-step. Update artifacts (`atris task`, MAP.md) as reality changes.
- **REVIEW:** Verify, test, clean up. Finish/review the task. Append lessons to `atris/policies/LESSONS.md`.

## TASK SOURCE OF TRUTH

Use `atris task` when available. It stores durable local SQLite task state,
append-only task events, and refreshes `.atris/state/tasks.projection.json` for
desktop/web/agent views.

`atris/TODO.md` is the readable fallback/projection. It can be rebuilt with
`atris task render --out atris/TODO.md`; do not rely on manual TODO.md edits for
ownership. In cloud business workspaces, Supabase `tasks` is the source of truth
and Swarlo is the live claim/report layer.

## RULES

- **MAPFIRST.** Read `atris/MAP.md` before grepping. It's the index.
- **Plan before code.** No code during planning.
- **One step at a time.** Verify before continuing.
- **Finish completed tasks.** Target state: task projection/TODO fallback = 0 active items.
- **Append lessons, don't rewrite.** History is sacred.
- **Read atris/wiki/ pages before answering domain questions.** Cite the page in your answer.

## CORE FILES

| File | Purpose |
|------|---------|
| `atris/atris.md` | This file — boot protocol |
| `atris/MAP.md` | Navigation index |
| `.atris/state/tasks.projection.json` | Current task projection |
| `atris/TODO.md` | Rendered/legacy task fallback |
| `atris/MEMBER.md` | Agent role + permissions |
| `atris/persona.md` | Voice, tone, style |
| `atris/goals.md` | Strategic direction |
| `atris/memory.md` | Persistent learned context |
| `atris/instructions.md` | Workflows and processes |
| `atris/wiki/` | Compiled knowledge base |
| `atris/context/` | Raw source materials |
| `atris/skills/` | Custom callable skills |
| `atris/team/` | Team member profiles |
| `atris/reports/` | Past artifacts |
| `atris/policies/LESSONS.md` | Append-only lessons |
| `atris/logs/YYYY/YYYY-MM-DD.md` | Daily journal |

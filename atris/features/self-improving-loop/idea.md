# Self-Improving Loop

> **Status:** shipped (v3.1.0–v3.3.0)
> **Created:** 2026-02-09
> **Last Updated:** 2026-04-13

---

## Problem Statement

Atris generates lessons learned in validate.md and journals — but nobody reads them next time. The system forgets what it learned. Every feature starts from zero instead of standing on the shoulders of the last one.

---

## Solution Design

Make Atris eat its own cooking. Before planning any new feature, the agent reads past validate.md files and journal entries for patterns — what worked, what broke, what took too long. Those lessons feed directly into the next idea.md, build.md, and validate.md. The system gets smarter with every cycle without anyone having to remember anything.

Three pieces:
1. **Lessons index** — A living file (`atris/lessons.md`) that accumulates validated learnings from completed features. Each entry is tagged by source feature and date.
2. **Pre-flight in the navigator** — Before writing idea.md, the navigator checks lessons.md for relevant patterns. "Last time we touched auth, X broke" becomes a constraint in the new idea.
3. **Post-validate harvesting** — After validator fills in validate.md, it extracts lessons (pass or fail) and appends them to lessons.md. The loop closes.

---

## ASCII Visualization

```
                    THE RECURSIVE LOOP

  ┌──────────┐     ┌──────────┐     ┌─────────────┐
  │ idea.md  │────▶│ build.md │────▶│ validate.md │
  │          │     │          │     │             │
  │ reads    │     │          │     │ writes      │
  │ LESSONS  │     │          │     │ LESSONS     │
  └────▲─────┘     └──────────┘     └──────┬──────┘
       │                                    │
       │         ┌──────────────┐           │
       └─────────│  lessons.md  │◀──────────┘
                 │              │
                 │  - pattern 1 │
                 │  - pattern 2 │
                 │  - pattern N │
                 └──────┬───────┘
                        │
                        ▼
                    journal/
                 (full history)

  Cycle 1: lessons = []
  Cycle 2: lessons = [what cycle 1 learned]
  Cycle 3: lessons = [what cycles 1+2 learned]
  ...
  Cycle N: the system knows everything it ever tried
```

---

## Success Criteria

- [ ] lessons.md exists and has a clear append-only format
- [ ] Navigator reads lessons.md before writing any new idea.md
- [ ] Validator extracts lessons from validate.md and appends to lessons.md
- [ ] A completed feature's lessons show up in the next feature's idea.md constraints
- [ ] The loop works on itself — this very feature's validate.md feeds lessons.md

---

## User Impact

Every feature you build makes the next one faster and safer. You stop repeating mistakes. The project develops institutional memory that survives across sessions, agents, and time.

---

## Technical Notes

- lessons.md is append-only to avoid merge conflicts and keep history intact
- Each lesson entry has: source feature, date, pass/fail, one-line takeaway
- Keep it flat — no categories, no hierarchy. Just a growing list. Agents can grep it.
- This is the project's long-term memory. The journal is daily. lessons.md is forever.

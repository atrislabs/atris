---
name: tidy
description: "Workspace maintenance and knowledge hygiene. Finds stale docs, broken refs, abandoned tasks, and fixes them. Use when things feel messy or you want the system to clean itself up. Triggers on: tidy, clean up, maintenance, lint, health check, freshen up."
version: 1.1.0
tags:
  - maintenance
  - knowledge
  - hygiene
  - docs
---

# /tidy

Finds what's rotting in your workspace and fixes it. Stale pages, broken references, abandoned tasks, outdated docs.

## When to use

- "Things feel messy"
- "Clean this up"
- After a big refactor when docs have drifted
- Periodically, to keep the knowledge base honest
- When you suspect MAP.md or wiki pages are out of date

## On invoke

1. Run `atris clean --dry-run` silently. Collect results.
2. Read atris/MAP.md, atris/TODO.md, and today's journal for context.
3. Scan for these problems (in priority order):

### What to look for

**Stale wiki pages** — pages with `last_compiled` frontmatter where the source files have been modified since. The page content may be wrong.

**Broken MAP.md references** — file:line refs that point to code that moved or was deleted. The auto-healer fixes what it can; report what it can't.

**Abandoned tasks** — in-progress tasks claimed more than 3 days ago. Either finish them, re-scope them, or delete them.

**Orphan docs** — markdown pages under atris/ that nothing links to. They're invisible and probably stale.

**Stale MAP.md** — if MAP.md hasn't been updated in >7 days and code has changed, the navigation is drifting.

**Empty sections** — TODO.md sections with placeholder text like "(empty)" or "(clean)".

4. Present findings as a numbered list, sorted by impact. For each:
   - What's wrong
   - Why it matters
   - What you'd do to fix it

5. Ask: "want me to fix these? all / pick numbers / skip"

6. Fix what they approve. For each fix:
   - Make the change
   - Update last_compiled if touching wiki pages
   - Commit with a clear message

7. After all fixes, run `atris clean` one more time to verify.

## Example

```
Found 4 things to improve:

1. MAP.md has 11 broken refs — 3 files moved, 8 functions renamed.
   These make navigation wrong. I can auto-heal most of them.

2. atris/TODO.md has a task claimed 26 days ago by Executor.
   It's blocking the in-progress slot. Should delete or re-scope.

3. MAP.md hasn't been updated in 25 days.
   Code has changed — the map is drifting from reality.

4. 2 empty sections in TODO.md.
   Just noise. Can clean them out.

want me to fix these? all / pick numbers / skip
```

## Rules

- Never delete user content without asking.
- Always show what you found before fixing.
- Commit fixes in small, clear commits (one per category).
- Update last_compiled frontmatter when recompiling wiki pages.
- Run atris clean at the end to verify everything is actually fixed.

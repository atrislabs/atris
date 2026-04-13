---
name: tidy
description: "Workspace maintenance and knowledge hygiene. Finds stale docs, broken refs, abandoned tasks, ghost names, duplicate scorecards, and fixes them. Use when things feel messy or you want the system to clean itself up. Triggers on: tidy, clean up, maintenance, lint, health check, freshen up, prune."
version: 2.0.0
tags:
  - maintenance
  - knowledge
  - hygiene
  - prune
---

# /tidy

Finds what's rotting in your workspace and fixes it. Not just broken refs — ghost names, stale lessons, duplicate data, language drift, dead code.

## When to use

- "Things feel messy"
- "Clean this up"
- "Prune"
- After a big refactor when docs have drifted
- Periodically, to keep the knowledge base honest
- Before a release, to make sure everything is true

## On invoke

1. Run `atris clean --dry-run` silently. Collect results.
2. Read atris/MAP.md, atris/TODO.md, atris/lessons.md, and today's journal.
3. Scan for these problems (in priority order):

### What to look for

**Ghost names** — terms that don't match the current identity. Check package.json `name` and `description`, README title, and PERSONA. Grep the codebase for old names (e.g., "atrisDev" when the product is "atris"). Flag any user-facing string that uses a dead name.

**Stale wiki pages** — pages with `last_compiled` frontmatter where the source files have been modified since. The page content may be wrong.

**Broken MAP.md references** — file:line refs that point to code that moved or was deleted. The auto-healer fixes what it can; report what it can't.

**Stale lessons** — lessons about bugs that have since been fixed. Grep the named files for the bug pattern. If it's gone, tag the lesson `[resolved]`.

**Duplicate scorecards** — same slug appearing twice in scorecards.md. Keep the one with more data, delete the other.

**Abandoned tasks** — in-progress tasks claimed more than 3 days ago. Either finish them, re-scope them, or delete them.

**Orphan docs** — markdown pages under atris/ that nothing links to. They're invisible and probably stale.

**Dead exports** — functions in module.exports that nothing imports. They add surface area for no reason.

**Stale TODO items** — tasks older than 14 days that haven't moved. Run `isStillTrue` on each. Tag stale ones `[unverified]`.

**Empty sections** — TODO.md sections with placeholder text like "(empty)" or "(clean)".

4. Present findings as a numbered list, sorted by impact. For each:
   - What's wrong (specific file, line, or term)
   - Why it matters (one sentence)
   - What you'd do to fix it (one sentence)

5. Ask: "want me to fix these? all / pick numbers / skip"

6. Fix what they approve. For each fix:
   - Make the change
   - Update last_compiled if touching wiki pages
   - Run tests after each fix
   - Commit with a clear message

7. After all fixes, run `atris clean` one more time to verify 0 issues.

## Example

```
found 5 things to tidy:

1. "atrisDev" appears 3 times in user-facing output (bin/atris.js:202, :1545).
   product name is "atris" now. fix: replace with current name.

2. lessons.md has 2 lessons about bugs that are already fixed.
   they'll mislead the next horizon pick. fix: tag [resolved].

3. scorecards.md has a duplicate entry for harden-rl-loop.
   policy will double-count that endgame. fix: keep the better one.

4. MAP.md has 4 refs that can't be auto-healed.
   navigation is wrong for those symbols. fix: update manually.

5. TODO.md has a task from 12 days ago that nobody touched.
   it's noise. fix: tag [unverified] or delete.

want me to fix these? all / pick numbers / skip
```

## Rules

- Never delete user content without asking.
- Always show what you found before fixing.
- Commit fixes in small, clear commits (one per category).
- Run tests after every fix. If tests break, revert and report.
- Update last_compiled frontmatter when recompiling wiki pages.
- Run atris clean at the end to verify 0 issues remain.
- Ghost names are highest priority. The workspace must speak one language.

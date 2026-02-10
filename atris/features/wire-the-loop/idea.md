# Wire the Loop

> **Status:** planning
> **Created:** 2026-02-09
> **Last Updated:** 2026-02-09

---

## Problem Statement

We built the idea→build→validate lifecycle and lessons.md feedback loop, but the CLI and docs don't know about it. The specs say the right things. The commands that activate those specs don't pass the information through. New users hit `atris init` and never get lessons.md. The docs still say "idea.md + build.md" in three places.

---

## Solution Design

8 surgical edits. Wire what exists into the places that reference it. No new concepts, no new files (except lessons.md at init). Just connecting the dots.

---

## ASCII Visualization

```
WHAT EXISTS (specs)          WHAT'S BROKEN (CLI + docs)
─────────────────           ──────────────────────────
navigator.md ✅              atris plan ❌ (no lessons.md)
  "read lessons.md"            doesn't show it

validator.md ✅              atris review ❌ (no lessons.md path)
  "harvest lessons"            says "extract learnings" generically

features/README ✅           atris init ❌ (no lessons.md created)
  "idea+build+validate"        new projects missing the file

                             GETTING_STARTED.md ❌ (idea+build only)
                             README.md ❌ (idea+build only)
                             atris.md ❌ (no features/ mention)
                             atris status ❌ (no lessons count)
                             atrisDevEntry ❌ (no lessons.md mention)
```

---

## Success Criteria

- [ ] `atris init` creates lessons.md in new projects
- [ ] `atris plan` surfaces lessons.md to the navigator
- [ ] `atris review` tells validator about lessons.md path
- [ ] `atris status` shows lessons count
- [ ] GETTING_STARTED.md says idea+build+validate
- [ ] README.md says idea+build+validate
- [ ] atris.md mentions features/ system
- [ ] atrisDevEntry mentions lessons.md

---

## Lessons Applied

From `lessons.md`: "Always check that templates are wired into the actual workflow, not just sitting in _templates/." — This is exactly that pattern again, one level up.

# Audit Gaps — Build Plan

> **For Executor Agent** — Follow these steps exactly.

---

## Files Touched

**Modified:**
- `atris/team/navigator.md` — Add PERSONA.md reference
- `atris/team/executor.md` — Add PERSONA.md reference
- `atris/team/validator.md` — Add PERSONA.md reference
- `atris/team/brainstormer.md` — Add PERSONA.md reference
- `atris/team/launcher.md` — Add PERSONA.md reference
- `atris/features/README.md` — Mark self-improving-loop as complete

---

## Build Steps

### Step 1: Add PERSONA.md to each agent's role header

Add `Read atris/PERSONA.md for communication style.` after the role line in each spec. One line, same spot in each file.

### Step 2: Mark self-improving-loop as complete

It shipped — lessons.md exists, navigator reads it, validator harvests from it. Move from Active to Completed in features/README.md.

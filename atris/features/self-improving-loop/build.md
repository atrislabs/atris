# Self-Improving Loop — Build Plan

> **For Executor Agent** — Follow these steps exactly.

---

## Overview

Wire up lessons.md as the feedback loop between validate.md outputs and idea.md inputs. Three touchpoints: the file itself, the navigator pre-flight, and the validator post-flight.

---

## Files Touched

**Created:**
- `atris/lessons.md` — Append-only lessons index

**Modified:**
- `atris/atris.md` — Add lessons.md to the spec (Phase 1 artifacts + agent behaviors)
- `atris/team/navigator.md` — Add "read lessons.md" to pre-flight checklist
- `atris/team/validator.md` — Add "harvest lessons" to post-validate step
- `atris/features/README.md` — Reference the loop in workflow section
- `atris/MAP.md` — Add lessons.md entry

---

## Build Steps

### Step 1: Create lessons.md

**File:** `atris/lessons.md`

**What to do:**
- Create the file with a header explaining the format
- Add one seed entry from a real past learning (the validate.md gap we just fixed)
- Format: `- **[YYYY-MM-DD] [feature-name]** — (pass|fail) — One-line lesson`

**Validation:**
- File exists, format is clear, seed entry is real

---

### Step 2: Update navigator spec

**File:** `atris/team/navigator.md`

**What to do:**
- Add to the navigator's pre-flight: "Read atris/lessons.md for relevant patterns before writing idea.md"
- If any lessons are relevant, reference them as constraints in the new idea.md

**Validation:**
- Navigator spec mentions lessons.md

---

### Step 3: Update validator spec

**File:** `atris/team/validator.md`

**What to do:**
- After filling validate.md, add a step: "Extract 1-2 lessons and append to atris/lessons.md"
- Format matches the established pattern
- Lessons should be extracted whether the feature passed or failed

**Validation:**
- Validator spec mentions lesson harvesting

---

### Step 4: Update atris.md spec

**File:** `atris/atris.md`

**What to do:**
- Add lessons.md to the list of system artifacts
- Describe it as append-only, harvested by validator, read by navigator
- Reference it in the plan → do → review loop description

**Validation:**
- Spec mentions lessons.md in artifact list and workflow

---

### Step 5: Update MAP.md

**File:** `atris/MAP.md`

**What to do:**
- Add lessons.md to the file index with description
- Mark it with the appropriate section

**Validation:**
- MAP.md has a lessons.md entry

---

## Testing Strategy

### Manual Testing

1. After build, verify lessons.md exists with seed entry
2. Run `atris plan` on a test feature — verify navigator mentions checking lessons
3. Run `atris review` — verify validator attempts to harvest lessons
4. Check that the harvested lesson appears in lessons.md

---

## Error Cases

**Error:** lessons.md doesn't exist when navigator reads it
**Handling:** Navigator skips gracefully — no lessons yet is fine

**Error:** Validator can't extract a clear lesson
**Handling:** Append "No clear lesson extracted" with the feature name — still record the attempt

---

## Dependencies

- validate.md must be part of the feature lifecycle (just shipped)
- Navigator and validator specs must exist in atris/team/

---

## Rollback Plan

1. Delete atris/lessons.md
2. Revert changes to navigator.md, validator.md, atris.md
3. System works exactly as before — no dependencies broken

---

## Notes for Executor

- Keep lessons.md dead simple. One line per lesson. No categories.
- The power is in the accumulation, not the organization.
- This feature should validate itself — its own validate.md should produce the first real harvested lesson.

# Validation — Self-Improving Loop

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If ANY step fails, the feature is broken.

---

## 1. Environment Check

- [ ] **Pre-flight**
  - Command: `cat atris/lessons.md`
  - Expect: File exists with header and at least one seed entry

---

## 2. Simulation Steps (The "Real" Test)

### Step 1: lessons.md format is correct

- **Action:** Read atris/lessons.md
- **Expect:** Each entry follows `- **[YYYY-MM-DD] [feature-name]** — (pass|fail) — One-line lesson`

### Step 2: Navigator reads lessons

- **Action:** Check atris/team/navigator/MEMBER.md for lessons.md reference
- **Expect:** Pre-flight checklist includes reading lessons.md

### Step 3: Validator harvests lessons

- **Action:** Check atris/team/validator/MEMBER.md for lesson harvesting step
- **Expect:** Post-validate includes appending to lessons.md

### Step 4: Spec includes lessons.md

- **Action:** Check atris/atris.md for lessons.md reference
- **Expect:** Listed as a system artifact with description

### Step 5: The recursion works

- **Action:** This validate.md produces a lesson. Append it to lessons.md.
- **Expect:** lessons.md now has an entry sourced from this very feature.

---

## 3. Regression Check

- [ ] `atris plan` still works (navigator didn't break)
- [ ] `atris review` still works (validator didn't break)
- [ ] Existing features (brainstorm, cli-ux-simplification) unaffected

---

**Status:** Verified

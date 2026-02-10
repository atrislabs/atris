# Validation — Self-Improving Loop

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If ANY step fails, the feature is broken.

---

## 1. Environment Check

- [ ] **Pre-flight**
  - Command: `cat atris/LESSONS.md`
  - Expect: File exists with header and at least one seed entry

---

## 2. Simulation Steps (The "Real" Test)

### Step 1: LESSONS.md format is correct

- **Action:** Read atris/LESSONS.md
- **Expect:** Each entry follows `- **[YYYY-MM-DD] [feature-name]** — (pass|fail) — One-line lesson`

### Step 2: Navigator reads lessons

- **Action:** Check atris/team/navigator.md for LESSONS.md reference
- **Expect:** Pre-flight checklist includes reading LESSONS.md

### Step 3: Validator harvests lessons

- **Action:** Check atris/team/validator.md for lesson harvesting step
- **Expect:** Post-validate includes appending to LESSONS.md

### Step 4: Spec includes LESSONS.md

- **Action:** Check atris/atris.md for LESSONS.md reference
- **Expect:** Listed as a system artifact with description

### Step 5: The recursion works

- **Action:** This validate.md produces a lesson. Append it to LESSONS.md.
- **Expect:** LESSONS.md now has an entry sourced from this very feature.

---

## 3. Regression Check

- [ ] `atris plan` still works (navigator didn't break)
- [ ] `atris review` still works (validator didn't break)
- [ ] Existing features (brainstorm, cli-ux-simplification) unaffected

---

**Status:** Pending

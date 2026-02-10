# Validation — Wire the Loop

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If ANY step fails, the feature is broken.

---

## 1. Environment Check

- [ ] **Pre-flight**
  - Command: `atris init` in a fresh temp directory
  - Expect: `atris/lessons.md` exists in the output

---

## 2. Simulation Steps (The "Real" Test)

### Step 1: Init creates lessons.md

- **Action:** `mkdir /tmp/test-wire && cd /tmp/test-wire && atris init`
- **Expect:** `atris/lessons.md` exists with header

### Step 2: Plan shows lessons.md

- **Action:** `atris plan` in a project with lessons.md
- **Expect:** Output includes lessons.md in context listing

### Step 3: Review mentions lessons.md path

- **Action:** `atris review` in a project
- **Expect:** Output includes "lessons.md" somewhere in the prompt

### Step 4: Status shows lessons count

- **Action:** `atris status` in a project with 1+ lessons
- **Expect:** Output includes lesson count (e.g., "1 lessons" or similar)

### Step 5: Docs say validate.md

- **Action:** `grep -c "validate.md" GETTING_STARTED.md README.md`
- **Expect:** Both files return 1+

### Step 6: Spec mentions features/

- **Action:** `grep -c "features/" atris/atris.md`
- **Expect:** Returns 1+

---

## 3. Regression Check

- [ ] `atris init` still works end-to-end (no errors)
- [ ] `atris plan` still outputs navigator context
- [ ] `atris review` still outputs validator context
- [ ] `atris status` still shows all existing metrics

---

**Status:** Pending

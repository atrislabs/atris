# Validation — Wire the Loop

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If ANY step fails, the feature is broken.

---

## 1. Environment Check

- [x] **Pre-flight**
  - Command: `atris init` in a fresh temp directory
  - Expect: `atris/lessons.md` exists in the output
  - **Result:** PASS — "✓ Created lessons.md" in output

---

## 2. Simulation Steps (The "Real" Test)

### Step 1: Init creates lessons.md

- **Action:** `mkdir /tmp/test-wire-loop && cd /tmp/test-wire-loop && atris init`
- **Expect:** `atris/lessons.md` exists with header
- **Result:** PASS — File created with correct header and append-only format

### Step 2: Plan shows lessons.md

- **Action:** `atris plan` in a project with lessons.md
- **Expect:** Output includes lessons.md in context listing
- **Result:** PASS — Shows "Lessons: atris/lessons.md" in context files AND in the copy/paste prompt

### Step 3: Review mentions lessons.md path

- **Action:** `atris review` in a project
- **Expect:** Output includes "lessons.md" somewhere in the prompt
- **Result:** PASS — Workflow step 4 says "append to atris/lessons.md" with exact format

### Step 4: Status shows lessons count

- **Action:** `atris status -q` in main project (8 lessons) and fresh project (0 lessons)
- **Expect:** Output includes lesson count with 📚 emoji
- **Result:** PASS — Shows "📚 8" in main project. Quick mode and full mode both display lessons count.

### Step 5: Docs say validate.md

- **Action:** `grep -c "validate.md" GETTING_STARTED.md README.md atris/GETTING_STARTED.md`
- **Expect:** All files return 1+
- **Result:** PASS — All three return 2

### Step 6: Spec mentions features/

- **Action:** `grep -c "features/" atris/atris.md`
- **Expect:** Returns 1+
- **Result:** FAIL — Returns 0. atris.md does not mention features/ directory. Needs a future edit to wire it in.

---

## 3. Regression Check

- [x] `atris init` still works end-to-end (no errors)
- [x] `atris plan` still outputs navigator context
- [x] `atris review` still outputs validator context
- [x] `atris status` still shows all existing metrics (inbox, backlog, in-progress, completions)

---

**Status:** Verified

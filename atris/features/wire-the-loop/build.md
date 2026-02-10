# Wire the Loop — Build Plan

> **For Executor Agent** — Follow these steps exactly.

---

## Overview

Connect lessons.md and validate.md to every CLI command and doc that should reference them. 8 edits across 7 files.

---

## Files Touched

**Modified:**
- `commands/init.js` — Create lessons.md during init
- `commands/workflow.js` — Wire lessons.md into plan + review
- `commands/status.js` — Show lessons count
- `bin/atris.js` — Mention lessons.md in atrisDevEntry
- `GETTING_STARTED.md` — Add validate.md to feature workflow
- `README.md` — Add validate.md to feature workflow
- `atris/atris.md` — Add features/ system to spec

---

## Build Steps

### Step 1: Wire `atris init` to create lessons.md

**File:** `commands/init.js`

**What to do:**
- After TODO.md creation block, add a block that creates `atris/lessons.md`
- Content: same header as the existing `atris/lessons.md` file
- Check existence first (don't overwrite)

---

### Step 2: Wire `atris plan` to show lessons.md

**File:** `commands/workflow.js` (planAtris function, lines 5-295)

**What to do:**
- In the context files list that gets printed, add lessons.md
- Read the file path and show it alongside MAP, TODO, journal

---

### Step 3: Wire `atris review` to mention lessons.md path

**File:** `commands/workflow.js` (reviewAtris function, lines 667+)

**What to do:**
- Where it says "Extract learnings for journal", add: "If anything surprised you, append to atris/lessons.md"
- Include the format string

---

### Step 4: Wire `atris status` to show lessons count

**File:** `commands/status.js`

**What to do:**
- Read atris/lessons.md, count lines matching `^- \*\*`
- Add count to the status output line

---

### Step 5: Wire atrisDevEntry to mention lessons.md

**File:** `bin/atris.js` (atrisDevEntry function)

**What to do:**
- After the validate.md line, add a line about lessons.md
- Keep it brief: one console.log

---

### Step 6: Fix GETTING_STARTED.md

**File:** `GETTING_STARTED.md` (root)

**What to do:**
- Find "idea.md + build.md" and change to "idea.md + build.md + validate.md"
- Do the same in `atris/GETTING_STARTED.md` if it exists

---

### Step 7: Fix README.md

**File:** `README.md` (root)

**What to do:**
- Find "idea.md + build.md" and change to "idea.md + build.md + validate.md"

---

### Step 8: Add features/ to atris.md spec

**File:** `atris/atris.md`

**What to do:**
- In the WORKFLOW section (after plan→do→review), add a brief note that substantial work uses atris/features/ with idea.md, build.md, validate.md
- Keep it to 2-3 lines — the INDEX already has lessons.md

---

## Testing Strategy

### Manual Testing

1. `rm -rf /tmp/test-atris && mkdir /tmp/test-atris && cd /tmp/test-atris && atris init` — verify lessons.md created
2. `atris plan` — verify lessons.md appears in context
3. `atris review` — verify lessons.md path mentioned
4. `atris status` — verify lessons count shown
5. Check GETTING_STARTED.md, README.md — verify validate.md mentioned

---

## Notes for Executor

- Don't refactor anything. Just add the missing references.
- Each step is independent — if one fails, the others still work.
- Match existing code style in each file. No new patterns.

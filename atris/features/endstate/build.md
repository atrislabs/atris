# Project Endstate — Build Plan

> **For Executor Agent** — Follow these steps exactly.

---

## Overview

Build a public head-to-head benchmark that compares a pinned single-model baseline against a coordinated stack run on the same autonomous improvement loop. The output is not just code; it is a benchmark anyone can rerun and score.

---

## Files Touched

**Created:**
- `atris/features/endstate/idea.md` - benchmark scope, scorecard, and win condition
- `atris/features/endstate/build.md` - implementation plan for the benchmark harness
- `atris/features/endstate/validate.md` - validator script for baseline vs stack runs
- `atris/features/endstate/endgame.md` - one-level-deeper benchmark contract and next move
- `atris/features/endstate/contract.md` - Level 1 task pair, scorecard, and operator rules
- `atris/features/endstate/artifact-schema.json` - shared evidence contract for both runs
- `atris/experiments/endstate-baseline/` - pinned single-model pack, fixtures, and artifact schema
- `atris/experiments/endstate-stack/` - coordinated stack pack, routing notes, and artifact schema

**Modified:**
- `commands/autopilot.js` - emit reproducible run artifacts and intervention counts
- `commands/experiments.js` - support Endstate pack execution and artifact capture
- `commands/loop.js` - refresh wiki state after benchmark runs
- `lib/wiki.js` - expose any helper needed for post-run memory refresh
- `README.md` - document the benchmark and how to rerun it
- `atris/MAP.md` - map the Endstate benchmark entry points
- `atris/features/README.md` - register the feature and later mark it shipped

**External target repo (benchmark corpus):**
- `../atrisos-backend/` - pinned repo snapshot for the backend track

---

## Build Steps

### Step 1: Freeze the benchmark contract

**Files:** `atris/features/endstate/*`

**What to do:**
- Lock the two benchmark tracks: `atris-cli` and `../atrisos-backend/`.
- Choose the concrete task set, time budget, and artifact schema.
- Write the scorecard so a third party could grade the runs without reinterpreting the rules.
- Define the allowed operator input for both baseline and stack runs.

**Validation:**
- A cold reader can say what counts as a win without asking follow-up questions.

---

### Step 2: Create repeatable experiment packs

**Files:** `atris/experiments/endstate-baseline/`, `atris/experiments/endstate-stack/`

**What to do:**
- Scaffold one experiment pack for the single-model baseline and one for the stack run.
- Store the exact task briefs, repo snapshots, artifact schema, and scoring template in each pack.
- Reuse the existing `atris experiments` framework; do not invent a parallel benchmark format.

**Validation:**
- `atris experiments validate` passes for both Endstate packs.

---

### Step 3: Instrument the execution loop

**Files:** `commands/autopilot.js`, `commands/experiments.js`

**What to do:**
- Capture the same artifact bundle for every run: prompt/context, changed files, tests run, review result, elapsed time, and intervention count.
- Make sure both the baseline and stack protocols emit the same schema.
- Keep the operator delta visible; hidden rescue work invalidates the benchmark.

**Validation:**
- A dry run produces a complete artifact bundle with no missing fields.

---

### Step 4: Compound memory on every run

**Files:** `commands/loop.js`, `lib/wiki.js`, `commands/autopilot.js`

**What to do:**
- Refresh local wiki state after each benchmark run.
- Record the pre-run and post-run wiki state in the artifact bundle.
- Keep the memory layer explicit so the stack can win on compounding context, not just raw edits.

**Validation:**
- Benchmark artifacts show that wiki state changed and can be inspected after the run.

---

### Step 5: Run baseline, run stack, publish the delta

**Files:** `README.md`, `atris/features/endstate/validate.md`, benchmark artifact dirs

**What to do:**
- Run the pinned baseline first.
- Run the stack second under the same budget and task set.
- Score both runs with the same rubric and publish the traces plus the winner.

**Validation:**
- Two rerunnable runs exist, one scorecard exists, and the winner is obvious from the artifacts.

---

## Testing Strategy

### Unit Tests

- Artifact schema test: every run emits the same required fields
- Experiments option parsing test: Endstate packs route through the existing CLI cleanly

### Integration Tests

- `atris experiments validate` passes for both benchmark packs
- `atris autopilot` emits benchmark artifacts without breaking normal operation
- post-run wiki refresh updates `STATUS.md` and related wiki state

### Manual Testing

1. Run the single-model baseline against the pinned task set.
2. Run the stack against the same task set and budget.
3. Compare scores, interventions, and reviewed outcomes.

---

## Error Cases

**Error:** Operator quietly does work outside the allowed benchmark path

**Handling:** Count it as intervention and record it in the artifact bundle; hidden help invalidates the run.

**Error:** Repo snapshots drift between baseline and stack runs

**Handling:** Pin commits up front and record them in the experiment pack before either run starts.

**Error:** The scorecard rewards chatter instead of shipped outcomes

**Handling:** Keep the primary metrics outcome-based: reviewed completion, tests, and intervention count.

---

## Dependencies

- Existing `atris autopilot` execution loop
- Existing `atris experiments` framework
- Existing `atris loop` / wiki state refresh
- Access to the sibling `../atrisos-backend/` repo at a pinned commit

---

## Rollback Plan

If the benchmark harness creates noise or invalid comparisons:

1. Remove the Endstate experiment packs and benchmark-only artifact emission.
2. Keep the feature pack docs as the canonical postmortem of what failed.
3. Verify `atris autopilot`, `atris experiments`, and `atris loop` still behave like before.

---

## Notes for Executor

- Do not add a new benchmark command unless the existing `experiments` and `autopilot` surfaces genuinely cannot carry the flow.
- The winning claim is about the system harness, not model supremacy in a vacuum.
- If the eval can be gamed by a chatty human, the eval is bad.

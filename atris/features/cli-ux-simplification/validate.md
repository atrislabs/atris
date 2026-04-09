---
last_compiled: 2026-04-09
sources:
  - bin/atris.js:199-337 (showHelp function — core workflow section)
  - commands/init.js:398-422 (TODO.md file creation via fs.writeFileSync)
  - commands/workflow.js:83-92 (planAtris — read TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:280-281 (planAtris — include TODO.md in user prompt)
  - commands/workflow.js:427-437 (doAtris — load and read TODO.md)
  - commands/workflow.js:746-755 (reviewAtris — read TODO.md)
  - atris/features/cli-ux-simplification/idea.md
  - atris/features/cli-ux-simplification/build.md
---

# CLI UX Simplification — Validation

> **Status:** v1 — shipped 2025-11-16
> **Exit Condition:** Help output clearly sections core workflow (plan/do/review) separate from optional helpers and cloud commands. TODO.md is created and read by init/plan/do/review. Legacy TASK_CONTEXTS.md still supported for backwards compatibility.

## Checks

### 1. Help Output Structure
- [x] `atris help` sections: Setup → Core workflow → Context & tracking → Optional helpers → Experiments → Cloud & agents
- [x] Core workflow grouped: plan, do, review, run (lines 226-230)
- [x] plan/do/review descriptions mention TODO.md (lines 345, 361, 377)
- [x] visualize marked as "Legacy visualization helper (prefer 'atris plan')" (line 249)
- [x] brainstorm and autopilot in "Optional helpers" section, not core (lines 247-248)

### 2. TODO.md Creation & Usage
- [x] `atris init` creates atris/TODO.md with placeholder content (commands/init.js:398-422)
- [x] TODO.md template includes Backlog, In Progress, Completed sections (init.js:398-422)
- [x] init calls console.log summary after creation (init.js:423)

### 3. Commands Read TODO.md
- [x] **plan**: Loads TODO.md for current state (workflow.js:83-92)
- [x] **plan**: Includes TODO.md in user prompt when present (workflow.js:280-281, 293)
- [x] **do**: Reads TODO.md to find tasks to execute (workflow.js:427-437)
- [x] **review**: Reads TODO.md for task context (workflow.js:746-755)
- [x] **status**: Reads TODO.md Backlog/In Progress sections (status.js with parseTodo)

### 4. Backwards Compatibility
- [x] Legacy TASK_CONTEXTS.md fallback documented in workflow.js:84 comment
- [x] state-detection.js prefers TODO.md but accepts TASK_CONTEXTS.md (not breaking)
- [x] No error messages if TASK_CONTEXTS.md missing (graceful degradation)

### 5. Features/ Alignment
- [x] init.js creates atris/features/ directory (v1.9.6 update, per MAP.md line 89)
- [x] init.js scaffolds atris/features/README.md template (templates/features-readme.md)
- [x] features/cli-ux-simplification listed in features/README.md as completed (line 142-149)
- [x] feature/README.md distinguishes "substantial work" (features/) from "simple tasks" (TODO.md) (lines 155-165)

### 6. Documentation & Specs Updated
- [x] atris.md Phase 3 reframed as TODO-based task context system (not TASK_CONTEXTS.md)
- [x] GETTING_STARTED.md references TODO.md as primary working set
- [x] PERSONA.md reflects plan→do→review as core loop
- [x] MAP.md By-Feature section highlights plan/do/review with file:line (lines 50-68)

## Context

Shipped in v2.0.0 (2025-11-16) as part of major UX restructuring. Navigator spec updated to generate structured tasks to TODO.md. Help output reorganized to reduce cognitive load: core workflow stands out, optional helpers clearly secondary, cloud commands discoverable but not default path.

Key decisions:
- TODO.md stays simple (Backlog/In Progress/Completed sections) to avoid overcomplication
- features/ for design docs and durable context (idea/build), TODO.md for tactical task list
- Backwards-compatible fallback to TASK_CONTEXTS.md for old projects
- visualize command kept but nudged toward plan (legacy not removed per v2.0.0 stability rules)

## Errors Hit

None. Implementation clean. Retroactively documented during /improve cycle (2026-04-06). Lesson learned: features-outlive-status — validate.md creation is the right trigger to update idea.md status from "planning" to "complete" when shipping.

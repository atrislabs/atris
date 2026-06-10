---
last_compiled: 2026-06-10
validated_by: devin
validation_notes: Re-verified 2026-06-10. Help still keeps setup, core workflow, context/tracking, optional helpers, and experiments separated. plan/do/review still read TODO.md with TASK_CONTEXTS fallback. Current task system regenerates TODO.md from durable task state, so the file is a readable board, not ownership truth. Line refs healed after showHelp/workflow/task-db growth.
sources:
  - bin/atris.js:284-451 (showHelp function — quick start, core workflow, context/tracking, sync)
  - commands/init.js:408-434 (TODO.md placeholder creation via fs.writeFileSync)
  - commands/workflow.js:411-413 (planAtris — read TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:619-633 (planAtris — include TODO.md in user prompt)
  - commands/workflow.js:768-779 (doAtris — load TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:1118-1121 (reviewAtris — read TODO.md or legacy TASK_CONTEXTS.md)
  - lib/task-db.js:1397-1429 (renderTodoMarkdown — regenerated TODO.md board)
---

# CLI UX Simplification — Validation

> **Status:** v2 — re-verified 2026-06-10
> **Exit Condition:** Help output clearly sections core workflow (plan/do/review) separate from optional helpers and cloud commands. TODO.md is created and read by init/plan/do/review, while `atris task render` keeps it aligned with durable task state. Legacy TASK_CONTEXTS.md is still supported for backwards compatibility.

## Checks

### 1. Help Output Structure
- [x] `atris help` keeps Setup, Core workflow, Context & tracking, Optional helpers, Experiments, and Sync separated (`bin/atris.js:312-364`)
- [x] Core workflow grouped: plan, do, review, run (`bin/atris.js:318-322`)
- [x] log, now, activate, radar, ctop, status live in Context & tracking (`bin/atris.js:324-346`)
- [x] brainstorm, autopilot, and visualize stay in Optional helpers (`bin/atris.js:347-353`)

### 2. TODO.md Creation & Usage
- [x] `atris init` creates atris/TODO.md with placeholder content (`commands/init.js:408-434`)
- [x] TODO.md template includes Backlog, In Progress, Completed sections (`commands/init.js:416-430`)
- [x] init calls console.log summary after creation (`commands/init.js:434`)
- [x] `atris task render` marks TODO.md as regenerated from durable task state (`lib/task-db.js:1397-1429`)

### 3. Commands Read TODO.md
- [x] **plan**: Loads TODO.md for current state (`commands/workflow.js:411-413`)
- [x] **plan**: Includes TODO.md in user prompt when present (`commands/workflow.js:619-633`)
- [x] **do**: Reads TODO.md to find tasks to execute (`commands/workflow.js:768-779`)
- [x] **review**: Reads TODO.md for task context (`commands/workflow.js:1118-1121`)
- [x] **status**: Reads TODO.md Backlog/In Progress sections (status.js with parseTodo)

### 4. Backwards Compatibility
- [x] Legacy TASK_CONTEXTS.md fallback documented in workflow.js:83 comment
- [x] state-detection.js prefers TODO.md but accepts TASK_CONTEXTS.md (not breaking)
- [x] No error messages if TASK_CONTEXTS.md missing (graceful degradation)

### 5. Features/ Alignment
- [x] init.js creates atris/features/ directory (v1.9.6 update, per MAP.md line 90)
- [x] init.js scaffolds atris/features/README.md template (inline content, init.js:486)
- [x] features/cli-ux-simplification listed in features/README.md as completed (line 142-149)
- [x] feature/README.md distinguishes "substantial work" (features/) from "simple tasks" (TODO.md) (lines 155-165)

### 6. Documentation & Specs Updated
- [x] atris.md TASK RULES section (line 101) defines TODO.md-based task system (not TASK_CONTEXTS.md)
- [x] GETTING_STARTED.md lists TODO.md in folder structure and key commands
- [x] PERSONA.md reflects plan→do→review as core loop
- [x] MAP.md By-Feature section highlights plan/do/review with file:line (lines 481-509)

## Context

Shipped in v2.0.0 (2025-11-16) as part of major UX restructuring. Navigator spec updated to generate structured tasks to TODO.md. Help output reorganized to reduce cognitive load: core workflow stands out, optional helpers clearly secondary, cloud commands discoverable but not default path.

Key decisions:
- TODO.md stays simple (Backlog/In Progress/Completed sections) to avoid overcomplication
- features/ for design docs and durable context (idea/build), TODO.md for tactical task list
- Backwards-compatible fallback to TASK_CONTEXTS.md for old projects
- visualize command kept but nudged toward plan (legacy not removed per v2.0.0 stability rules)

## Errors Hit

None. Implementation clean. Retroactively documented during /improve cycle (2026-04-06). Lesson learned: features-outlive-status — validate.md creation is the right trigger to update idea.md status from "planning" to "complete" when shipping.

---
last_compiled: 2026-06-23
validated_by: executor
validation_notes: Re-verified 2026-06-18. Reconciled all drifted file:line refs against current source after showHelp/init/workflow/task-db growth. showHelp now also lists pulse + spaceship in Core workflow. TODO.md is regenerated from durable task state (lib/task-db.js renderTodoMarkdown), so the file is a readable board, not ownership truth. state-detection moved to lib/; MAP.md plan/do/review lives in the "Agent Activation Commands" By-Feature section.
sources:
  - bin/atris.js:290-467 (showHelp function — quick start, setup, core workflow, context/tracking, sync)
  - commands/init.js:419-446 (TODO.md placeholder creation via fs.writeFileSync)
  - commands/workflow.js:411-413 (planAtris — read TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:619-633 (planAtris — include TODO.md in user prompt)
  - commands/workflow.js:768-779 (doAtris — load TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:1118-1121 (reviewAtris — read TODO.md or legacy TASK_CONTEXTS.md)
  - lib/task-db.js:1494-1527 (renderTodoMarkdown — regenerated TODO.md board)
---

# CLI UX Simplification — Validation

> **Status:** v3 — re-verified 2026-06-18
> **Exit Condition:** Help output clearly sections core workflow (plan/do/review) separate from optional helpers and cloud commands. TODO.md is created and read by init/plan/do/review, while `atris task render` keeps it aligned with durable task state. Legacy TASK_CONTEXTS.md is still supported for backwards compatibility.

## Checks

### 1. Help Output Structure
- [x] `atris help` keeps Setup, Core workflow, Context & tracking, Optional helpers, Experiments, and Sync separated (`bin/atris.js:318-380`)
- [x] Core workflow grouped: plan, do, review, run — now also pulse + spaceship (`bin/atris.js:324-330`)
- [x] log, now, activate, radar, ctop, status live in Context & tracking (`bin/atris.js:332-338`)
- [x] brainstorm, autopilot, and visualize stay in Optional helpers (`bin/atris.js:356-361`)

### 2. TODO.md Creation & Usage
- [x] `atris init` creates atris/TODO.md with placeholder content (`commands/init.js:419-446`)
- [x] TODO.md template includes Backlog, In Progress, Completed sections (`commands/init.js:427-441`)
- [x] init calls console.log summary after creation (`commands/init.js:445`)
- [x] `atris task render` marks TODO.md as regenerated from durable task state (`lib/task-db.js:1494-1527`)

### 3. Commands Read TODO.md
- [x] **plan**: Loads TODO.md for current state (`commands/workflow.js:411-413`)
- [x] **plan**: Includes TODO.md in user prompt when present (`commands/workflow.js:619-633`)
- [x] **do**: Reads TODO.md to find tasks to execute (`commands/workflow.js:768-779`)
- [x] **review**: Reads TODO.md for task context (`commands/workflow.js:1118-1121`)
- [x] **status**: Reads TODO.md Backlog/In Progress sections (status.js with parseTodo)

### 4. Backwards Compatibility
- [x] Legacy TASK_CONTEXTS.md fallback documented in workflow.js:411 comment (also :768, :1118)
- [x] lib/state-detection.js prefers TODO.md but accepts TASK_CONTEXTS.md (not breaking) (`lib/state-detection.js:50-51`)
- [x] No error messages if TASK_CONTEXTS.md missing (graceful degradation)

### 5. Features/ Alignment
- [x] init.js creates atris/features/ directory (v1.9.6 update, per MAP.md:139; create at `commands/init.js:508-516`)
- [x] init.js scaffolds atris/features/README.md template (inline content, `commands/init.js:514-515`)
- [x] features/cli-ux-simplification listed in features/README.md as completed (lines 145-152)
- [x] features/README.md distinguishes "substantial work" (features/) from "simple tasks" (TODO.md) (lines 156-168)

### 6. Documentation & Specs Updated
- [x] atris.md `## task source of truth` section (`atris.md:61-67`) defines the `atris task` / TODO.md task system (not TASK_CONTEXTS.md)
- [x] GETTING_STARTED.md lists TODO.md in folder structure and key commands
- [x] PERSONA.md reflects plan→do→review as core loop
- [x] MAP.md "Agent Activation Commands" By-Feature section highlights plan/do/review with file:line (`atris/MAP.md:815-843`)

## Context

Shipped in v2.0.0 (2025-11-16) as part of major UX restructuring. Navigator spec updated to generate structured tasks to TODO.md. Help output reorganized to reduce cognitive load: core workflow stands out, optional helpers clearly secondary, cloud commands discoverable but not default path.

Key decisions:
- TODO.md stays simple (Backlog/In Progress/Completed sections) to avoid overcomplication
- features/ for design docs and durable context (idea/build), TODO.md for tactical task list
- Backwards-compatible fallback to TASK_CONTEXTS.md for old projects
- visualize command kept but nudged toward plan (legacy not removed per v2.0.0 stability rules)

Drift notes (reconciled 2026-06-18): the help surface has grown since v2.0.0 — Core workflow now also lists `pulse` and `spaceship`; `state-detection.js` moved from `commands/` to `lib/`; `renderTodoMarkdown` (the TODO.md board generator) lives at `lib/task-db.js:1494-1527` and ends right before `appendSection`; MAP.md's old plan/do/review range now points at the Brainstorm Mode section, so the canonical plan/do/review By-Feature block is "Agent Activation Commands" at `atris/MAP.md:815-843`.

## Errors Hit

None. Implementation clean. Retroactively documented during /improve cycle (2026-04-06). Lesson learned: features-outlive-status — validate.md creation is the right trigger to update idea.md status from "planning" to "complete" when shipping. Re-verification 2026-06-18 hit no errors; every ref was re-read against source before re-stamping.

---
last_compiled: 2026-07-12
validated_by: executor
validation_notes: Re-verified 2026-07-12. Reconciled the top-level help against the current AI-computer front door, mission/task/brain context commands, business/cloud sections, and durable TODO rendering. TODO.md remains a readable board regenerated from durable task state, not ownership truth.
sources:
  - bin/atris.js:388-606 (showHelp function - quick start, setup, workflow, context/tracking, sync, business, cloud agents, skills, team)
  - commands/init.js:416-441 (TODO.md placeholder creation via fs.writeFileSync)
  - commands/workflow.js:411-413 (planAtris — read TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:619-633 (planAtris — include TODO.md in user prompt)
  - commands/workflow.js:768-779 (doAtris — load TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:1118-1121 (reviewAtris — read TODO.md or legacy TASK_CONTEXTS.md)
  - lib/task-db.js:1611-1719 (renderTodoMarkdown — regenerated TODO.md board)
---

# CLI UX Simplification — Validation

> **Status:** v4 - re-verified 2026-07-12
> **Exit Condition:** Help output opens with the persistent AI computer path, keeps plan/do/review/run separate from optional helpers and cloud/business commands, and names the durable task/mission/brain surfaces. TODO.md is created and read by init/plan/do/review, while `atris task render` keeps it aligned with durable task state. Legacy TASK_CONTEXTS.md is still supported for backwards compatibility.

## Checks

### 1. Help Output Structure
- [x] `atris help` starts with the persistent AI computer quick start and common invocations (`bin/atris.js:394-410`)
- [x] Setup stays separate from the working loop (`bin/atris.js:419-424`)
- [x] Core workflow groups plan, do, review, run, run logs, run search, pulse, and spaceship (`bin/atris.js:425-434`)
- [x] Context & tracking names the live operating surfaces: launchpad, task, mission, learn, brain, lesson, ingest/query/lint/loop (`bin/atris.js:435-477`)
- [x] Optional helpers stay secondary: brainstorm, autopilot, improve, worktree, visualize, youtube (`bin/atris.js:478-489`)
- [x] Sync, business, cloud agents, skills, team, plugin, feedback, and other commands are separate sections (`bin/atris.js:509-604`)

### 2. TODO.md Creation & Usage
- [x] `atris init` creates atris/TODO.md with placeholder content (`commands/init.js:419-446`)
- [x] TODO.md template includes Backlog, In Progress, Completed sections (`commands/init.js:427-441`)
- [x] init calls console.log summary after creation (`commands/init.js:440`)
- [x] `atris task render` marks TODO.md as regenerated from durable task state (`lib/task-db.js:1611-1719`)

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
- [x] init.js creates atris/features/ directory (`commands/init.js:508-516`)
- [x] init.js scaffolds atris/features/README.md template (inline content, `commands/init.js:514-515`)
- [x] features/cli-ux-simplification listed in features/README.md as completed (lines 145-152)
- [x] features/README.md distinguishes "substantial work" (features/) from "simple tasks" (TODO.md) (lines 156-168)

### 6. Documentation & Specs Updated
- [x] atris.md `## task source of truth` section (`atris.md:85-110`) defines the `atris task` / TODO.md task system (not TASK_CONTEXTS.md)
- [x] GETTING_STARTED.md lists TODO.md in folder structure and key commands
- [x] PERSONA.md reflects plan→do→review as core loop
- [x] MAP.md "Agent Activation Commands" By-Feature section highlights plan/do/review with file:line (`atris/MAP.md:832-861`)

## Context

Shipped in v2.0.0 (2025-11-16) as part of major UX restructuring. Navigator spec updated to generate structured tasks to TODO.md. Help output reorganized to reduce cognitive load: core workflow stands out, optional helpers clearly secondary, cloud commands discoverable but not default path.

Key decisions:
- TODO.md stays simple (Backlog/In Progress/Completed sections) to avoid overcomplication
- features/ for design docs and durable context (idea/build), TODO.md for tactical task list
- Backwards-compatible fallback to TASK_CONTEXTS.md for old projects
- visualize command kept but nudged toward plan (legacy not removed per v2.0.0 stability rules)

Drift notes (reconciled 2026-07-12): the help surface has grown since v2.0.0 into an AI-computer front door. Core workflow now includes run logs/search, pulse, and spaceship; Context & tracking now exposes launchpad, task, mission, brain, lesson, and local wiki commands; `renderTodoMarkdown` lives at `lib/task-db.js:1611-1719`.

## Errors Hit

None. Implementation clean. Retroactively documented during /improve cycle (2026-04-06). Lesson learned: features-outlive-status - validate.md creation is the right trigger to update idea.md status from "planning" to "complete" when shipping. Re-verification 2026-07-12 hit no errors; the top-level help ref was re-read against source before re-stamping.

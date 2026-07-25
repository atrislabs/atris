---
last_compiled: 2026-07-25
validated_by: mission-lead
validation_notes: Re-verified 2026-07-25. Since the 2026-07-24 stamp `bin/atris.js` gained one help line (`sync-checkout`, now bin/atris.js:581), pushing showHelp's close from :675 to :676 and shifting every Sync-and-below section by one. Re-pinned the anchors and the in-body check refs, which had been left at pre-2026-07-12 line numbers. Behavior is unchanged and still complete.
sources:
  - bin/atris.js:447-676 (showHelp function - quick start, setup, workflow, context/tracking, sync, business, cloud agents, skills, team)
  - commands/init.js:456-482 (TODO.md placeholder creation via fs.writeFileSync)
  - commands/workflow.js:412-417 (planAtris reads TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:619-621 (planAtris includes TODO.md in user prompt)
  - commands/workflow.js:774-784 (doAtris loads TODO.md or legacy TASK_CONTEXTS.md)
  - commands/workflow.js:1124-1129 (reviewAtris reads TODO.md or legacy TASK_CONTEXTS.md)
  - lib/task-db.js:1952-1984 (renderTodoMarkdown, the regenerated TODO.md board)
---

# CLI UX Simplification — Validation

> **Status:** v4 - re-verified 2026-07-25
> **Exit Condition:** Help output opens with the persistent AI computer path, keeps plan/do/review/run separate from optional helpers and cloud/business commands, and names the durable task/mission/brain surfaces. TODO.md is created and read by init/plan/do/review, while `atris task render` keeps it aligned with durable task state. Legacy TASK_CONTEXTS.md is still supported for backwards compatibility.

## Checks

### 1. Help Output Structure
- [x] `atris help` starts with the persistent AI computer quick start and common invocations (`bin/atris.js:454-476`)
- [x] Setup stays separate from the working loop (`bin/atris.js:482-487`)
- [x] Core workflow groups plan, do, review, run, run logs, run search, pulse, and spaceship (`bin/atris.js:488-497`)
- [x] Context & tracking names the live operating surfaces: launchpad, task, mission, learn, brain, lesson, ingest/query/lint/loop (`bin/atris.js:498-545`)
- [x] Optional helpers stay secondary: brainstorm, autopilot, improve, worktree, visualize, youtube (`bin/atris.js:546-559`)
- [x] Sync, business, cloud agents, skills, team, plugin, feedback, and other commands are separate sections (`bin/atris.js:578-675`)

### 2. TODO.md Creation & Usage
- [x] `atris init` creates atris/TODO.md with placeholder content (`commands/init.js:456-482`)
- [x] TODO.md template includes Backlog, In Progress, Completed sections (`commands/init.js:463-479`)
- [x] init reports the creation through `markReady` (`commands/init.js:482`)
- [x] `atris task render` marks TODO.md as regenerated from durable task state (`lib/task-db.js:1952-1984`, banner at `lib/task-db.js:1961`)

### 3. Commands Read TODO.md
- [x] **plan**: Loads TODO.md for current state (`commands/workflow.js:412-417`)
- [x] **plan**: Includes TODO.md in user prompt when present (`commands/workflow.js:619-621`)
- [x] **do**: Reads TODO.md to find tasks to execute (`commands/workflow.js:774-784`)
- [x] **review**: Reads TODO.md for task context (`commands/workflow.js:1124-1129`)
- [x] **status**: Reads TODO.md Backlog/In Progress sections (`commands/status.js:102`, `:121` via `parseTodo` from `lib/todo`, used only when the task DB is absent)

### 4. Backwards Compatibility
- [x] Legacy TASK_CONTEXTS.md fallback documented in workflow.js:412 comment (also :774, :1124)
- [x] lib/state-detection.js prefers TODO.md but accepts TASK_CONTEXTS.md (not breaking) (`lib/state-detection.js:50-51`)
- [x] No error messages if TASK_CONTEXTS.md missing (graceful degradation)

### 5. Features/ Alignment
- [x] init.js creates atris/features/ directory (`commands/init.js:545-553`)
- [x] init.js scaffolds atris/features/README.md template (inline content, `commands/init.js:552-553`)
- [x] features/cli-ux-simplification listed in features/README.md as completed (lines 145-152)
- [x] features/README.md distinguishes "substantial work" (features/) from "simple tasks" (TODO.md) (lines 156-168)

### 6. Documentation & Specs Updated
- [x] atris.md `## task source of truth` section (`atris.md:123-194`) defines the `atris task` / TODO.md task system (not TASK_CONTEXTS.md)
- [x] GETTING_STARTED.md lists TODO.md in folder structure and key commands
- [x] PERSONA.md reflects plan→do→review as core loop
- [x] MAP.md "Agent Activation Commands" By-Feature section highlights plan/do/review with file:line (`atris/MAP.md:1092-1122`)

## Context

Shipped in v2.0.0 (2025-11-16) as part of major UX restructuring. Navigator spec updated to generate structured tasks to TODO.md. Help output reorganized to reduce cognitive load: core workflow stands out, optional helpers clearly secondary, cloud commands discoverable but not default path.

Key decisions:
- TODO.md stays simple (Backlog/In Progress/Completed sections) to avoid overcomplication
- features/ for design docs and durable context (idea/build), TODO.md for tactical task list
- Backwards-compatible fallback to TASK_CONTEXTS.md for old projects
- visualize command kept but nudged toward plan (legacy not removed per v2.0.0 stability rules)

Drift notes (reconciled 2026-07-12): the help surface has grown since v2.0.0 into an AI-computer front door. Core workflow now includes run logs/search, pulse, and spaceship; Context & tracking now exposes launchpad, task, mission, brain, lesson, and local wiki commands.

Drift notes (reconciled 2026-07-25): `renderTodoMarkdown` now lives at `lib/task-db.js:1952-1984`. The help body has grown past the six sections this page originally checked: `Atris Computers:` (:477), `Experiments:` (:560), `Quick commands:` (:574), `GitHub for Context:` (:586), `Code Review:` (:609), and `Integrations:` (:631) are also top-level sections now. The grouping principle still holds, so the checks above were re-pinned rather than expanded.

## Errors Hit

None. Implementation clean. Retroactively documented during /improve cycle (2026-04-06). Lesson learned: features-outlive-status - validate.md creation is the right trigger to update idea.md status from "planning" to "complete" when shipping. Re-verification 2026-07-12 hit no errors; the top-level help ref was re-read against source before re-stamping. Re-verification 2026-07-25 hit no errors either: the only source change since the last stamp was the `sync-checkout` help line, which does not change any behavior this page validates.

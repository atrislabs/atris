# Features

This directory contains feature documentation for the Atris project.

---

## Structure

Each feature gets its own folder:

```
atris/features/
├── _templates/               # Templates for new features
│   ├── idea.md.template      # Problem, solution, visualization
│   ├── build.md.template     # Step-by-step build instructions
│   ├── validate.md.template  # Proof it works (or didn't)
│   └── changelog.md.template # Release notes entry
├── feature-name-1/
│   ├── idea.md               # Why we're building this
│   ├── build.md              # How to build it
│   └── validate.md           # Proof it works
└── feature-name-2/
    ├── idea.md
    ├── build.md
    └── validate.md
```

---

## Creating a New Feature

### Automatic (Recommended)

Run `atris` or `atris plan` and describe what you want. The agent will:
1. Show visualization
2. Wait for approval
3. Create the feature folder with idea.md + build.md + validate.md

### Manual

If you want to create a feature manually:

```bash
# Copy templates
mkdir atris/features/your-feature-name
cp atris/features/_templates/idea.md.template atris/features/your-feature-name/idea.md
cp atris/features/_templates/build.md.template atris/features/your-feature-name/build.md
cp atris/features/_templates/validate.md.template atris/features/your-feature-name/validate.md

# Fill in the templates
# Edit idea.md (problem, solution, visualization)
# Edit build.md (step-by-step implementation)
# Edit validate.md (proof it works — filled by validator)
```

---

## Workflow

**Navigator Agent (idea.md):**
1. Shows visualization
2. Gets approval
3. Creates `idea.md` + `build.md` + `validate.md` (from templates)
4. Adds entry to this README

**Executor Agent (build.md):**
1. Reads `build.md`
2. Executes step by step
3. Updates status as work progresses

**Validator Agent (validate.md):**
1. Fills in `validate.md` — runs every check, records pass/fail
2. If all pass → status "complete", lessons learned to journal
3. If any fail → status stays "in-progress", lessons learned to journal
4. Updates MAP.md if needed

---

## Feature Status

### Active Features

None.

---

### Completed Features

#### audit-gaps
Close remaining audit gaps from self-audit
- **Files:** atris/team/*/MEMBER.md, atris/features/README.md, atris/features/audit-gaps/*
- **Status:** complete
- **Keywords:** audit, persona, cleanup
- **What:** Agent member specs reference PERSONA.md for communication style, and stale feature statuses are cleaned up
- **Completed:** 2026-05-19

#### endstate
Public benchmark for proving a coordinated stack beats a pinned single-model baseline
- **Files:** atris/features/endstate/*, commands/autopilot.js, commands/experiments.js, commands/loop.js, lib/wiki.js
- **Status:** complete
- **Keywords:** benchmark, endstate, autopilot, experiments, eval
- **What:** Defines the benchmark, scorecard, and build plan for a head-to-head run across `atris-cli` and `atrisos-backend`
- **Completed:** 2026-04-08

#### wiki-loop
Deterministic upkeep loop for the local wiki
- **Files:** commands/loop.js, lib/wiki.js, commands/wiki.js, bin/atris.js, test/commands.test.js, test/cli-smoke.test.js, atris/skills/loop/SKILL.md, atris/features/wiki-loop/*
- **Status:** complete
- **Keywords:** wiki, loop, upkeep, stale, orphan, status
- **What:** Adds `atris loop` and `atris wiki loop` to refresh `STATUS.md` + `log.md`, detect stale/orphan pages, and suggest the next ingest without auto-push
- **Completed:** 2026-04-07

#### wiki
Local-first project wiki with cloud opt-in
- **Files:** lib/wiki.js, commands/wiki.js, commands/init.js, commands/activate.js, commands/pull.js, commands/push.js, bin/atris.js, test/commands.test.js, test/cli-smoke.test.js, atris/skills/wiki/SKILL.md, atris/wiki/*
- **Status:** complete
- **Keywords:** wiki, ingest, local-first, cloud, memory
- **What:** Canonical `atris/wiki/` scaffold, local-first ingest/query/lint, `--only wiki` sync alias, init/activate integration, project-local wiki skill, seeded repo wiki
- **Completed:** 2026-04-07

#### self-improving-loop
Make Atris recursive — validate.md lessons feed back into the next idea.md
- **Files:** atris/lessons.md (new), atris.md, atris/team/navigator/MEMBER.md, atris/team/validator/MEMBER.md, atris/MAP.md
- **Status:** complete
- **Keywords:** recursion, lessons, feedback-loop, self-improving, lessons.md
- **What:** lessons.md accumulates validated learnings; navigator reads them before planning; validator harvests them after validating
- **Completed:** 2026-02-09

#### wire-the-loop
Connect lessons.md and validate.md to every CLI command and doc that references them
- **Files:** commands/init.js, commands/workflow.js, commands/status.js, bin/atris.js, GETTING_STARTED.md, README.md, atris/atris.md
- **Status:** complete
- **Keywords:** wiring, cli, docs, lessons, validate, init, plan, review, status
- **What:** 8 surgical edits to wire lessons.md and validate.md into init, plan, review, status, docs, and spec
- **Completed:** 2026-02-09

#### brainstorm — v2.0.0
Conversational exploration mode for uncertain ideas
- **Files:** bin/atris.js, atris/atris.md, atris/PERSONA.md, GETTING_STARTED.md, README.md, atris/MAP.md
- **Status:** complete
- **Keywords:** brainstorm, conversational, exploration, pre-planning, v2.0.0
- **What:** Optional step 0 before `atris plan` for exploring ideas one question at a time
- **Why:** Users need supportive thinking partner when uncertain about requirements
- **Completed:** 2025-11-11 (shipped in v2.0.0)

#### cli-ux-simplification — v2.0.0
Simplified CLI surface around the core workflow and aligned internal artifacts.
- **Files:** bin/atris.js, commands/init.js, commands/workflow.js, commands/status.js, commands/brainstorm.js, lib/state-detection.js, atris.md, atris/atris.md, GETTING_STARTED.md, atris/GETTING_STARTED.md, AGENT.md, CLAUDE.md, atris/PERSONA.md, PERSONA.md
- **Status:** complete
- **Keywords:** cli, ux, plan-do-review, todo, features
- **What:** Clarified help output and behavior so `plan`, `do`, and `review` are the primary loop, with `TODO.md` + features + logs as the underlying structure.
- **Why:** Makes it easier for humans and agents to understand and consistently use the CLI without memorizing many commands.
- **Completed:** 2025-11-16

#### cloud-sync-simplicity
Make cloud sync's safe path the default: per-conflict review, orphan cleanup, scoped push
- **Files:** commands/business-sync.js, commands/cloud.js, commands/push.js, commands/sync.js
- **Status:** complete
- **Keywords:** sync, cloud, conflicts, orphans, push
- **What:** `atris sync --review` picks local/cloud/merge per conflicting file (`commands/business-sync.js:355`), `atris cloud clean` previews and deletes cloud orphans (`commands/cloud.js:22`), and push leads with the safe path on drift (`commands/push.js:349`)

#### codex-goal-replacement
Bridge Atris mission selection into the Codex visible goal
- **Files:** commands/codex-goal.js, commands/mission.js, bin/atris.js
- **Status:** complete
- **Keywords:** codex, goal, mission, bridge
- **What:** `atris codex-goal` writes `.atris/state/codex_goal.json` (schema `atris.codex_goal.v1`) so the Codex runtime can mirror `goal.visible_goal` into the native goal UI

#### company-brain-sync
Sync the atris/ brain surface of a business workspace instead of raw file mirroring
- **Files:** lib/company-brain-sync.js, commands/business-sync.js, commands/sync.js
- **Status:** complete
- **Keywords:** sync, business, company-brain, workspace
- **What:** `atris sync --status` renders business, brain file count, conflict packets, and watcher heartbeat without credentials

#### pack-recovery
Recover recorded pack file work after an interrupted run
- **Files:** commands/pack.js
- **Status:** complete
- **Keywords:** pack, recover, recovery, protected-files
- **What:** `atris pack run --recover <receipt.json>` marks completed files protected and continues the run (`commands/pack.js:166`, `:2536`)

#### plan-review-by-validator
Validator gate between plan and do so half-specified plans never execute
- **Files:** commands/autopilot.js, test/autopilot-plan-review.test.js
- **Status:** complete
- **Keywords:** plan, review, validator, signoff
- **What:** the validator reads each plan fresh and returns a machine-parseable SIGNOFF/REJECT verdict before execution (`commands/autopilot.js:1249-1510`)

#### self-driving-mission
Give Atris a destination once; it owns route, staffing, recovery, and the arrival receipt
- **Files:** commands/mission.js, lib/runner-command.js, lib/fleet.js
- **Status:** complete
- **Keywords:** mission, self-driving, route, engine, autoland
- **What:** `atris mission run` drives a durable objective with `--due`, `--max-ticks`, and `--complete-on-pass` (`commands/mission.js:581-641`)

#### spaceship
Bounded, self-reporting overnight runner
- **Files:** commands/spaceship.js, scripts/spaceship.sh
- **Status:** complete
- **Keywords:** spaceship, overnight, runner, supervised-loop
- **What:** `atris spaceship` wraps the supervised loop script that survives bad ticks and reports each state change

#### team-member-standard
MEMBER.md directory format for team members
- **Files:** atris/team/*/MEMBER.md
- **Status:** complete
- **Keywords:** member, MEMBER.md, team, standard
- **What:** every team member lives in `atris/team/<name>/MEMBER.md`; init and sync ship them into user projects (`commands/sync.js:526-531`)

#### verify-falsifiability
The Verify field must be a real rubric that fails before work and passes after
- **Files:** commands/verify.js, commands/autopilot.js
- **Status:** complete
- **Keywords:** verify, falsifiable, rubric, reward
- **What:** `atris verify` runs the task's rubric against the tree; a rubric that already passes halts the tick instead of counting a fake success

---

### Parked Features

#### customer-skill-zones
- **Status:** parked, partially shipped; private publish parked per `atris/features/customer-skill-zones/idea.md`

---

## Guidelines

**When to create a feature folder:**
- Substantial new functionality (not a 5-line fix)
- Multiple files affected
- Needs design discussion
- Will take multiple sessions

**When to use TODO.md instead:**
- Simple tasks (1-2 files)
- Quick fixes
- Refactoring
- Bug fixes

**Naming convention:**
- Use kebab-case: `user-authentication`, `csv-export`, `rate-limiting`
- Be specific: `oauth-login` not just `auth`
- Keep it short: 2-3 words max

---

## Need Help?

- See `atris/GETTING_STARTED.md` for setup
- See `atris/PERSONA.md` for workflow
- Run `atris help` for commands

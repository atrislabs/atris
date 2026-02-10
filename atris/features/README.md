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
│   └── validate.md.template  # Proof it works (or didn't)
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

#### self-improving-loop
Make Atris recursive — validate.md lessons feed back into the next idea.md
- **Files:** atris/lessons.md (new), atris.md, atris/team/navigator.md, atris/team/validator.md, atris/MAP.md
- **Status:** planning
- **Keywords:** recursion, lessons, feedback-loop, self-improving, lessons.md
- **What:** lessons.md accumulates validated learnings; navigator reads them before planning; validator harvests them after validating
- **Why:** Every feature should make the next one smarter. The system should never forget what it learned.

#### wire-the-loop
Connect lessons.md and validate.md to every CLI command and doc that references them
- **Files:** commands/init.js, commands/workflow.js, commands/status.js, bin/atris.js, GETTING_STARTED.md, README.md, atris/atris.md
- **Status:** complete
- **Keywords:** wiring, cli, docs, lessons, validate, init, plan, review, status
- **What:** 8 surgical edits to wire lessons.md and validate.md into init, plan, review, status, docs, and spec
- **Why:** Specs say the right things but the CLI and docs don't pass the info through
- **Why:** Every feature should make the next one smarter. The system should never forget what it learned.

---

### Completed Features

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

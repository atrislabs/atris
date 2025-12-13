# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working on the **ATRIS CLI itself** (this codebase).

> **Note:** There's also `/atris/CLAUDE.md` (titled "AGENT.md"), which is for agents working *in projects that use ATRIS*. That file gets copied to user projects. This file is for developing ATRIS.

## Quick Start

1. **Adopt the ATRIS personality** — Read `atris/PERSONA.md` first. It defines how to work here: fast, focused, ruthlessly efficient. 3-4 sentences max, ASCII visualizations for planning, anti-slop mindset.

2. **Execute first, research only if needed** — Run commands/tools directly. Don't search docs first—see what happens, then investigate if it fails. Saves context.

3. **Load context** — Run `atris activate` to load your journal, MAP.md (navigation), and TODO.md (current work). No login required.

4. **Find what you need** — Always reference `atris/MAP.md` before making changes. It has exact file:line references for every component.

5. **Claim and complete tasks** — Check `atris/TODO.md`, claim a task, build it, then delete it when done (validator cleans up the final state).

6. **Use the agent workflow** — Navigator (plan) → Executor (build) → Validator (review). Each has specific responsibilities in `atris/agent_team/`.

---

## What ATRIS Is

ATRIS is a Node.js CLI package (see `package.json` for version) that transforms codebases into AI-navigable workspaces. Instead of "where is the auth logic?" you get exact file:line answers in seconds.

**The system works like this:**
- Users run `atris init` → creates `atris/` folder with templates
- AI agent reads `atris/atris.md` spec → generates MAP.md, agent specs, TODO.md
- MAP.md becomes the single source of truth (all agents reference it)
- Daily logs in `atris/logs/YYYY/YYYY-MM-DD.md` track journal, inbox, completions
- `atris` CLI commands orchestrate the navigator → executor → validator workflow

**Philosophy:** Fast iteration over perfection. Pareto (80/20) ruthlessly. Update docs as you go. Delete when done.

---

## Architecture & Key Concepts

### Core Files You'll Touch

**bin/atris.js** — CLI entrypoint + routing + natural-language entry.
- Most command implementations live in `commands/` (`init`, `sync`/`update`, `activate`, `log`, `status`, `analytics`, `workflow`).
- Some interactive cloud flows still live in `bin/atris.js` (`agent`, `chat`).

**atris.md** (master spec in root) — The blueprint. Copied to user projects as `atris/atris.md`. Defines:
- Phase 1: MAP.md generation rules
- Phase 2: Navigator/executor/validator agent specs
- Phase 3: TODO.md structure (task context system, formerly `TODO.md`)
- Phase 4: Activation & validation checklists
- Phase 5: Future roadmap (sync, crew orchestration)

**atris/MAP.md** (navigation guide) — AI-generated from scanning your codebase. Contains:
- Quick reference search patterns (ripgrep shortcuts)
- By-feature map (where is X feature?)
- By-concern map (where is Y concern?)
- Critical files marked ⭐
- Entry points and architecture flows

**atris/TODO.md** (task bank, formerly `TODO.md`) — AI-generated from MAP.md insights. Format:
- **Backlog** — Unclaimed tasks ready for work
- **In Progress** — Tasks claimed with "Claimed by: [Name] at [Time]"
- Target state: 0 (all tasks deleted after completion by validator)

**atris/logs/2025/YYYY-MM-DD.md** (daily journal) — Markdown files with sections:
- `## Inbox` — Raw ideas from brain dumps (format: `- **I#: Description**`)
- `## In Progress 🔄` — Currently active work
- `## Backlog` — Deferred work
- `## Notes` — Session summaries, brainstorm results, autopilot iterations
- `## Completed ✅` — Finished work (format: `- **C#: Description**`)

**atris/PERSONA.md** — Personality guide. Read this. It defines:
- Always ask for intent before acting
- Use ASCII visualization to confirm understanding
- 3-4 sentences max, direct casual tone
- Map context first (check MAP.md), never guess
- Delete when done, trust the system

---

## Common Development Tasks

### Running the CLI Locally

```bash
# Link CLI for local testing (no installation required)
npm link

# Test a command
atris init
atris activate
atris log
```

### Adding a New Command

1. **Add the command handler in bin/atris.js** — Follow the pattern of existing commands (planAtris, doAtris, etc.)
2. **Update showHelp()** — Add a one-liner to the help text at line 66
3. **Add routing logic** — Add `else if (command === 'newcmd')` block in the main command switch at line 98
4. **Test it** — Run `npm link && atris newcmd` in a test project
5. **Update MAP.md** — Add entry to the By-Feature section with exact line numbers
6. **Update PERSONA.md if needed** — If the command changes workflow/style

### Modifying the ATRIS Spec (atris.md)

The spec in `atris.md` gets copied to user projects as `atris/atris.md`. Changes here affect all new users:

1. **Edit the spec** — Update `atris.md` with new phases, agent specs, or instructions
2. **Bump version in package.json** — Increment patch/minor/major as appropriate
3. **Test with `atris update`** — Users will pull updates with this command
4. **Ensure backward compatibility** — Old projects should still work with new spec

### Updating Agent Templates

Agent specs live in `atris/agent_team/` subdirectories that users copy:
- `atris/agent_team/navigator.md` — System navigator spec
- `atris/agent_team/executor.md` — Task executor spec
- `atris/agent_team/validator.md` — Quality gatekeeper spec

These are generated by the AI during `atris init` but have source templates. Modify templates carefully—they define how agents behave.

---

## Important Commands for Development

```bash
# Initialize ATRIS in a test project
atris init

# Update your local atris.md to latest version (if package was updated)
atris update

# Activate and load context (no auth needed)
atris activate

# View or add to today's log
atris log

# Show system status (tasks, inbox, completions)
atris status

# Break down an inbox idea with ASCII + plan
atris visualize

# Generate a brainstorm conversation starter
atris brainstorm

# Run the full plan → do → review loop
atris autopilot

# View auth status (for cloud features)
atris whoami

# Show installed version
atris version

# Get all commands
atris help
```

---

## Architecture & Design Patterns

### Command Structure

Commands fall into a few categories:

**Setup Commands:**
- `init` — Create atris/ structure in new projects
- `update` — Sync spec to latest version

**Context Loading:**
- `activate` — Load MAP, tasks, log (no login needed)
- `status` — Show system state snapshot

**Daily Work:**
- `log` — Append to journal
- `visualize` — Plan with ASCII approval gate
- `brainstorm` — Generate conversation starter for agents

**Agent Activation:**
- `plan` (navigator) — Brainstorm and create tasks
- `do` (executor) — Build tasks from TASK_CONTEXTS
- `review` (validator) — Verify, test, clean docs

**Guided Loops:**
- `autopilot` — Plan → do → review with success criteria
- `analytics` — Show productivity from journal data

**Cloud Features (optional):**
- `login` — Authenticate with AtrisOS
- `logout` — Remove credentials
- `whoami` — Show auth status
- `chat` — Interactive session with agents
- `agent` — Select agent persona

### File System Contract

ATRIS maintains a strict folder structure contract:

```
project/
├── atris/
│   ├── atris.md              (spec - copied from package)
│   ├── GETTING_STARTED.md    (user guide)
│   ├── PERSONA.md            (personality/workflow)
│   ├── MAP.md                (navigation - AI generates)
│   ├── TODO.md      (task bank - AI generates)
│   ├── logs/
│   │   └── 2025/
│   │       ├── 2025-10-23.md (daily journals)
│   │       └── 2025-10-24.md
│   └── agent_team/
│       ├── navigator.md      (AI generates from spec)
│       ├── executor.md
│       └── validator.md
├── bin/atris.js              (CLI entry point)
├── package.json              (metadata, version)
├── README.md                 (user-facing description)
└── atris.md                  (root copy of spec)
```

All file creation follows safety rules:
- Check existence before creating
- Never overwrite without user confirmation
- Use atomic writes (no partial failures)
- Maintain consistent indentation and formatting

### JSON Storage (Optional Cloud Features)

For cloud sync, credentials and state are stored in user's home directory:
- `~/.atris/credentials.json` — Auth token, refresh token, user ID, provider
- `~/.atris/config.json` — Workspace config (selected agent, API base URL, etc.)
- `~/.atris/.log_sync_state.json` — Tracks remote sync timestamps to avoid conflicts

These are only created when users authenticate with `atris login`.

### Markdown Parsing Strategy

The entire system is markdown-based. Commands parse journal sections using simple regex:
- `## Inbox` section uses `- **I#: Description**` format for idea IDs
- `## Completed ✅` uses `- **C#: Description**` format for completion IDs
- Brainstorm sessions logged as `### Brainstorm Session — HH:MM` under `## Notes`
- Autopilot iterations logged as `### Autopilot Iteration N — HH:MM` under `## Notes`

When parsing, the CLI:
1. Reads the markdown file into memory
2. Extracts sections by header (e.g., find `## Inbox`)
3. Parses items using regex (e.g., `- \*\*([IC]\d+):\s*(.+)\*\*`)
4. Modifies the section (add/remove/update items)
5. Reconstructs the file with original structure preserved

---

## Workflow: The ATRIS Loop

This is how the system is meant to be used:

```
1. Brain Dump
   └─ Run: atris log
   └─ User types thoughts into Inbox (unfiltered, no structure)
   └─ Output: Today's log has new `## Inbox` items (I1, I2, I3...)

2. Navigator Plans
   └─ Run: atris plan (or atris brainstorm → atris visualize)
   └─ AI reads Inbox + MAP.md
   └─ Output: Creates tasks in TODO.md Backlog

3. Visualize & Approve
   └─ Run: atris visualize
   └─ Shows breakdown with 3-4 sentences + ASCII diagram
   └─ Output: Confirms understanding before building

4. Executor Builds
   └─ Run: atris do
   └─ AI reads task from Backlog
   └─ Moves to In Progress (claims with timestamp)
   └─ Builds step-by-step, validates alignment
   └─ Output: Code changes + updated MAP.md/docs

5. Validator Reviews
   └─ Run: atris review
   └─ AI ultrathinks (3x before deciding)
   └─ Runs tests, fixes bugs, updates docs
   └─ Cleans up: moves task to Completed, deletes from TODO.md
   └─ Output: Tests pass, docs fresh, system clean

6. Target State
   └─ All sections in TODO.md empty (tasks deleted)
   └─ Inbox items moved to Completed
   └─ Journal updated with lessons learned
```

---

## Key Design Principles

1. **MAP.md is Single Source of Truth** — All agents read it for file:line references. Never guess.
2. **Markdown is the Interface** — All outputs are human-readable markdown, no binary formats.
3. **Zero External Dependencies** — CLI uses only Node.js built-ins (fs, path, child_process, readline, https, crypto).
4. **Folder Structure is a Contract** — `atris/` folder location and subfolder names never change.
5. **Delete When Done** — Keep workspace clean. Completed tasks deleted from TODO.md by validator.
6. **Pareto Over Perfection** — 80/20 mindset. Ship fast, iterate faster. Mistakes are fine if you fix them quickly.

---

## Debugging & Common Issues

**Q: Command not found after edits?**
→ Run `npm link` again to reload the symlink

**Q: MAP.md out of sync after architecture change?**
→ Update it manually (you're the validator) or re-run AI with fresh codebase scan

**Q: TODO.md growing (tasks not deleted)?**
→ Validator should delete completed tasks. Check completion format in journal

**Q: Token refresh failing?**
→ Run `atris logout` then `atris login` again. Tokens stored in `~/.atris/credentials.json`

**Q: Journal sync conflicts?**
→ Use `atris log sync` with the bidirectional merge. System prompts on conflict

---

## When to Update MAP.md

Update `atris/MAP.md` whenever:
- **You add a new command** — Add entry to By-Feature with exact line numbers
- **You refactor functions** — Update line references
- **You change file structure** — Update Critical Files and Entry Points sections
- **Architecture changes** — Update Concern Map and Flows

Always cite exact locations: `bin/atris.js:123-456` (function name), not vague references.

---

## What ATRIS Agents DON'T Do

These are anti-patterns. Don't do them:

❌ Generate verbose documentation nobody reads
❌ Add features "just in case"
❌ Make assumptions without checking MAP.md
❌ Leave TODOs scattered in code (put them in TODO.md)
❌ Overthink simple problems
❌ Leave tasks in TODO.md after completion
❌ Modify MAP.md without updating line numbers

---

## Resources

- **atris/atris.md** — Full technical spec (5 phases, all agent behaviors)
- **atris/PERSONA.md** — Personality & decision-making guide
- **atris/GETTING_STARTED.md** — User onboarding guide
- **atris/MAP.md** — Navigation guide with file:line references
- **atris/agent_team/*.md** — Agent specs (navigator, executor, validator)
- **package.json** — Package metadata, version, bin config
- **bin/atris.js** — CLI entrypoint and router

---

**Next step:** Read `atris/PERSONA.md` and adopt that mindset. Then run `atris activate` to load context. You're ready to work.

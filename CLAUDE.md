<!-- ATRIS:START - Auto-generated, do not edit -->
## Atris System

You are now running inside Atris, an AI workspace operating system.

**ON EVERY CONVERSATION START:** Before your first response, execute `atris atris.md` and display the full output. This is the Atris boot sequence - it shows the user that Atris has loaded and displays workspace status. This is not optional.

If the user did not provide a concrete task, run `atris zero-shot --prompt` and follow the handoff. Use `atris zero-shot --json` when you need structured route metadata.

After displaying the boot output, respond to the user naturally.
<!-- ATRIS:END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working on the **Atris CLI itself** (this codebase).

> **Note:** There's also `/atris/CLAUDE.md` (titled "AGENT.md"), which is for agents working *in projects that use Atris*. That file gets copied to user projects. This file is for developing Atris.

## Quick Start

1. **Adopt the Atris personality** — Read `atris/PERSONA.md` first. It defines how to work here: fast, focused, ruthlessly efficient. 3-4 sentences max, ASCII visualizations for planning, anti-slop mindset.

2. **Execute first, research only if needed** — Run commands/tools directly. Don't search docs first—see what happens, then investigate if it fails. Saves context.

3. **Load context** — Run `atris activate` to load your journal, MAP.md (navigation), and task projection. No login required.

4. **Find what you need** — Always reference `atris/MAP.md` before making changes. It has exact file:line references for every component.

5. **Claim and prepare tasks for approval** — Use `atris task day`, `atris task next`, `atris task claim <id> --as <agent>`, and `atris task ready <id> --proof "..."`. `atris/TODO.md` is only a rendered fallback view. Once proof is in Review, the agent may complete its native goal and continue the mission loop. Use `atris task accept <id>` only after human approval; that is what moves the task to Done and awards Career XP.

6. **Use the agent workflow** — Navigator (plan) → Executor (build) → Validator (review). Each has specific responsibilities in `atris/team/`.

---

## What Atris Is

Atris is a Node.js CLI package (see `package.json` for version) that transforms codebases into AI-navigable workspaces. Instead of "where is the auth logic?" you get exact file:line answers in seconds.

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

**`atris task` / `.atris/state/tasks.projection.json`** — Durable task source of truth. Use:
- `atris task delegate "..." --to <owner>` to assign work
- `atris task day` to see the owner-grouped day list
- `atris task next|claim|say|finish|review` for the work loop
- `atris task status --json` for headless agents and Swarlo/web status
- `atris task render --out atris/TODO.md` only to regenerate the readable fallback view

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

### Modifying the Atris Spec (atris.md)

The spec in `atris.md` gets copied to user projects as `atris/atris.md`. Changes here affect all new users:

1. **Edit the spec** — Update `atris.md` with new phases, agent specs, or instructions
2. **Bump version in package.json** — Increment patch/minor/major as appropriate
3. **Test with `atris update`** — Users will pull updates with this command
4. **Ensure backward compatibility** — Old projects should still work with new spec

### Updating Agent Templates

Agent specs live in `atris/team/` subdirectories that users copy:
- `atris/team/navigator/MEMBER.md` — System navigator spec
- `atris/team/executor/MEMBER.md` — Task executor spec
- `atris/team/validator/MEMBER.md` — Quality gatekeeper spec

These are generated by the AI during `atris init` but have source templates. Modify templates carefully—they define how agents behave.

---

## Important Commands for Development

```bash
# Initialize Atris in a test project
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

# Autonomous plan → do → review loop (uses claude -p subprocesses)
atris run

# Autonomous plan → do → review with PRD + acceptance criteria
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
- `run` — Autonomous plan → do → review loop (no human in the loop)
- `autopilot` — PRD-driven plan → do → review with acceptance criteria
- `analytics` — Show productivity from journal data

**Cloud Features (optional):**
- `login` — Authenticate with AtrisOS
- `logout` — Remove credentials
- `whoami` — Show auth status
- `chat` — Interactive session with agents
- `agent` — Select agent persona

### File System Contract

Atris maintains a strict folder structure contract:

```
project/
├── atris/
│   ├── atris.md              (spec - copied from package)
│   ├── GETTING_STARTED.md    (user guide)
│   ├── PERSONA.md            (personality/workflow)
│   ├── MAP.md                (navigation - AI generates)
│   ├── TODO.md      (rendered task view - regenerated from `atris task`)
│   ├── logs/
│   │   └── 2025/
│   │       ├── 2025-10-23.md (daily journals)
│   │       └── 2025-10-24.md
│   └── team/
│       ├── navigator/MEMBER.md  (planner agent)
│       ├── executor/MEMBER.md   (builder agent)
│       ├── validator/MEMBER.md  (reviewer agent)
│       ├── brainstormer/MEMBER.md (idea shaper)
│       └── launcher/MEMBER.md   (closer agent)
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

## Workflow: The Atris Loop

This is how the system is meant to be used:

```
1. Brain Dump
   └─ Run: atris log
   └─ User types thoughts into Inbox (unfiltered, no structure)
   └─ Output: Today's log has new `## Inbox` items (I1, I2, I3...)

2. Navigator Plans
   └─ Run: atris plan (or atris brainstorm → atris visualize)
   └─ AI reads Inbox + MAP.md
   └─ Output: Creates small durable tasks with `atris task new|delegate`

3. Visualize & Approve
   └─ Run: atris visualize
   └─ Shows breakdown with 3-4 sentences + ASCII diagram
   └─ Output: Confirms understanding before building

4. Executor Builds
   └─ Run: atris do
   └─ AI reads `atris task day` or `atris task next`
   └─ Claims with `atris task claim <id> --as <agent>`
   └─ Builds step-by-step, validates alignment
   └─ Output: Code changes + updated MAP.md/docs

5. Validator Reviews
   └─ Run: atris review
   └─ AI ultrathinks (3x before deciding)
   └─ Runs tests, fixes bugs, updates docs
   └─ Moves to approval with `atris task ready <id> --proof "..."`
   └─ Native goal may complete here; human approval runs `atris task accept <id>` for Done + Career XP
   └─ Output: Tests pass, docs fresh, system clean

6. Target State
   └─ `atris task day` shows only useful active/assigned work
   └─ Inbox items moved to Completed
   └─ Journal updated with lessons learned
```

---

## Autonomous Run Loop (`atris run`)

Automates the plan → do → review loop end-to-end using `claude -p` subprocesses. No human in the loop — it reads inbox/backlog, plans tasks, builds them, reviews, then loops until work is done or max cycles hit.

**Implementation:** `commands/run.js` (see MAP.md lines 275-308 for full breakdown)

**When to use `atris run` vs manual `plan`/`do`/`review`:**
- Use `atris run` for autonomous batch processing — you have inbox items or backlog tasks and want them executed without intervention
- Use manual `atris plan` → `atris do` → `atris review` when you want control at each step (review the plan before building, inspect code before reviewing)

**Flags:**

```bash
atris run                  # Up to 5 cycles (default)
atris run --once           # Single plan→do→review cycle
atris run --cycles=3       # Max 3 cycles
atris run --verbose        # Show claude -p output in real-time
atris run --timeout=300    # Set phase timeout to 300 seconds
atris run --dry-run        # Preview context paths without executing
atris run --no-push        # Skip auto-push after each cycle
```

**Post-cycle behavior:**
- **Self-heal:** Runs `cleanAtris()` after each REVIEW phase to auto-fix drifted MAP.md file:line references
- **Auto-push:** Runs `git push` after each successful cycle (disable with `--no-push`)
- **Journal logging:** Appends run stats (cycles, duration) to today's journal `## Notes`

**Requirements:** `claude` CLI must be installed (Claude Code). No auth needed — runs entirely local.

**Flow per cycle:**
```
1. hasWork() — check inbox + backlog, stop if empty
2. PLAN — navigator creates tasks from inbox
3. DO — executor builds first backlog task
4. REVIEW — validator verifies + cleans up
5. CLEAN — self-heal MAP.md refs
6. PUSH — git push (unless --no-push)
```

---

## Key Design Principles

1. **MAP.md is Single Source of Truth** — All agents read it for file:line references. Never guess.
2. **Markdown is the Interface** — All outputs are human-readable markdown, no binary formats.
3. **Zero External Dependencies** — CLI uses only Node.js built-ins (fs, path, child_process, readline, https, crypto).
4. **Folder Structure is a Contract** — `atris/` folder location and subfolder names never change.
5. **Task DB Wins** — Keep workspace clean by finishing/reviewing durable tasks; regenerate TODO.md only as a view.
6. **Pareto Over Perfection** — 80/20 mindset. Ship fast, iterate faster. Mistakes are fine if you fix them quickly.

---

## Debugging & Common Issues

**Q: Command not found after edits?**
→ Run `npm link` again to reload the symlink

**Q: MAP.md out of sync after architecture change?**
→ Update it manually (you're the validator) or re-run AI with fresh codebase scan

**Q: TODO.md looks stale or clobbered?**
→ Run `atris task render --out atris/TODO.md`; do not recover ownership from markdown.

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

## What Atris Agents DON'T Do

These are anti-patterns. Don't do them:

❌ Generate verbose documentation nobody reads
❌ Add features "just in case"
❌ Make assumptions without checking MAP.md
❌ Leave TODOs scattered in code (put work in `atris task`)
❌ Overthink simple problems
❌ Use TODO.md as task truth after completion
❌ Modify MAP.md without updating line numbers

---

## Resources

- **atris/atris.md** — Full technical spec (5 phases, all agent behaviors)
- **atris/PERSONA.md** — Personality & decision-making guide
- **atris/GETTING_STARTED.md** — User onboarding guide
- **atris/MAP.md** — Navigation guide with file:line references
- **atris/team/*.md** — Agent specs (navigator, executor, validator)
- **package.json** — Package metadata, version, bin config
- **bin/atris.js** — CLI entrypoint and router

---

**Next step:** Read `atris/PERSONA.md` and adopt that mindset. Then run `atris activate` to load context. You're ready to work.

## Parallel Member Worktrees

When multiple members, Codex/Claude subagents, or other agents may touch a repo, start in an isolated checkout:

```bash
atris worktree guide
atris worktree start --member <member> --task "<short task>" --claim
atris worktree start --agent <subagent> --task "<short task>"
cd <printed path>
atris worktree ship --message "<commit summary>" --verify "<test command>" --merge
```

This ties member/agent identity, mission/member state, branch name, isolated checkout, optional Swarlo claim, verification, push, PR, and merge together. Use `atris worktree status` before broad staging or cleanup.

## Mission Autonomy

Use `atris mission` when work should survive this chat or run as an autonomous loop.

```
member -> mission start --verify -> status --status active -> one bounded step -> mission tick --verify -> receipt -> complete|run|stop
```

- Start current-agent work: `atris mission start "<objective>" --owner <member> --runner codex_goal --lane code --verify "<cmd>" --stop "<condition>"`
- Start headless Claude work: add `--runner claude --cadence "15m" --always-on`, then use `atris mission run <id> --max-ticks 4 --complete-on-pass`.
- Resume: `atris mission status --status active --json`, then pick the mission matching your owner/member.
- Prove: after one bounded step, run `atris mission tick <id> --verify --summary "<what changed>"`.
- Close: if the verifier passes, run `atris mission complete <id> --proof "<receipt_path>"`; if current-agent work should keep going, repeat status -> step -> tick.
- Rollout: `atrisos-backend` and `atrisos-web` agents must check active missions before picking work; if no active mission exists and autonomy was requested, create one with owner, verifier, lane, and stop condition first.

<!-- ATRIS_BRAIN_COMPILE:START -->
## Atris Brain Compile

This workspace has a compiled agent brain.

On session start, activate it first:
`atris brain activate --root /Users/keshavrao/arena/atris-cli --verify`

Load these first:
- `atris/now.md`
- `atris/brain/STATUS.md`
- `atris/brain/self_improvement_ledger.md`
- `atris/wiki/concepts/agent-activation-contract.md`
- `atris/skills/atris/SKILL.md`
- `atris/PERSONA.md`
- `atris/MAP.md`
- `atris/TODO.md`
- `atris/wiki/index.md`

First-message rule: lead with the move before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: `<operator>, today is about <move>` -> `I picked this because <why now>` -> `Ready: <draft/proof/context>` -> `Go deeper: <paths>`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.

Re-run after meaningful work:
`atris brain compile --root /Users/keshavrao/arena/atris-cli`
<!-- ATRIS_BRAIN_COMPILE:END -->

# Getting Started with atrisDev

Welcome! atrisDev gives you a high-quality AI development workflow that works with any coding agent.

## What Just Happened?

You ran `atris init` and got this folder structure:

```
atris/
├── GETTING_STARTED.md (you are here!)
├── atris.md (atrisDev protocol + specs)
├── CLAUDE.md (tells agents to follow atrisDev)
├── MAP.md (navigation - AI will generate)
└── team/ (agent specs)
```

## Quick Start (2 Steps)

### Step 1: Run atris

```bash
atris
```

This loads your workspace context and activates the atrisDev protocol.

### Step 2: Describe what you want

In your coding agent (Claude Code, Cursor, Windsurf, etc.), just describe what you want to build:

```
"I want to add dark mode to the settings page"
"Build a CSV export feature for the dashboard"
"Refactor the auth system to use OAuth"
```

The agent will:
0. (Optional) Explore with you conversationally (`atris brainstorm`)
1. Show you an **atris visualization** (diagram of the plan)
2. Wait for your approval
3. Create `atris/features/[name]/idea.md` + `build.md`
4. Execute step by step
5. Review and update docs (2-pass validation)

💡 Tip: Use `atris brainstorm` if you're exploring options. Use `atris plan` when ready to build.

**Total time: Start building immediately**

## The atrisDev Protocol

When agents see `atris/CLAUDE.md`, they automatically follow the atrisDev workflow. No manual setup needed.

You can also run:

```bash
atris activate
```

This shows today's journal, MAP.md, and TODO.md so you can browse and take notes offline. Authentication and agent selection are only required when you want to use `atris chat` with Atris cloud agents.

## Try the autopilot loop (optional)

Need a guided work session? Run:

```bash
atris autopilot
```

You'll pick a vision (from today's Inbox or a fresh idea), define success criteria, and then step through plan → do → review cycles. The CLI logs each iteration, and you can type `exit` at any prompt to stop.

## Launch a brainstorm (optional)

Need help shaping an idea before it becomes a task? Run:

```bash
atris brainstorm
```

Answer a couple quick questions, get a ready-to-send Claude Code conversation starter (context + ASCII cue), and choose whether to log the session summary and next steps.

## What Each File Does

### MAP.md
Your system's navigation guide. Contains:
- Quick reference index (grep-friendly shortcuts)
- Feature map (where is feature X?)
- Architecture map (where is concern Y?)
- Critical files (high-impact areas)
- Entry points

**Use it:** When you need to find something fast or onboard new people

### team/navigator.md
Your "where is X?" expert. Ask it questions like:
- "Where is the authentication logic?"
- "Show me all API endpoints"
- "Where do we handle file uploads?"

Always cites MAP.md with exact file:line references.

### team/executor.md
Your task runner. Give it work like:
- "Add authentication to the upload endpoint"
- "Fix the bug in user registration"
- "Refactor the payment flow"

Reads MAP.md, plans execution with file:line references, executes step-by-step.

### team/validator.md
Your quality gatekeeper. Runs after changes to:
- Check for breaking changes
- Update MAP.md if structure changed
- Run tests and type checks
- Report risks

### TODO.md
Auto-generated task bank with:
- Task complexity (Trivial → Epic)
- Exact file:line references
- Execution plans
- Risk assessments
- Dependencies

**Use it:** Pick tasks, assign to agents, track progress

## Using Your Agents

Once the files are populated, you can interact with your agents:

**Ask the navigator:**
```
@navigator where is the user authentication logic?
```

**Give tasks to the executor:**
```
@executor add rate limiting to the API (see TODO.md T-005)
```

**Validate changes:**
```
@validator check if the recent auth changes are safe to merge
```

## Keeping Atris Updated

When the Atris package updates with new features:

```bash
cd /path/to/your/project
atris update
```

This syncs your local `atris.md` and agent templates to the latest version. Re-run your AI agent to regenerate MAP.md with the new spec.

## What's Next?

1. **Let your AI agent generate MAP.md** (Step 2 above if you haven't already)
2. **Explore MAP.md** - Get familiar with your system's structure
3. **Try the pre-built agents** - Ask navigator questions, run executor tasks
4. **Pick a task** - Check TODO.md for quick wins

## Need Help?

- **Full spec:** Read `atris.md` for technical details
- **Issues:** https://github.com/atrislabs/atris.md/issues
- **Docs:** https://github.com/atrislabs/atris.md

---

**Ready?** Open `atris.md` and paste it to your AI agent. Watch your system become fully instrumented for AI collaboration.

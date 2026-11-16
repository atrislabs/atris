# atris

**The operating system for agent teams: shared memory, workspaces, and tools that run entire operations across code, research, and business.**

You say what you want in plain words. Atris plans it, builds it, checks it, and compounds what your agents learn across every session.

```bash
npm install -g atris
cd your-project
atris init && atris
```

> **Are you an agent?** Run `atris`, then read [`FOR_AGENTS.md`](FOR_AGENTS.md) and `atris/atris.md`.

---

## 1. Shared Memory in Your Repo

Atris gives Claude Code, Codex, Cursor, and any other agent a shared memory that lasts across sessions. Everything lives in plain files inside your repo, reviewed in git like code:

```text
atris/
├── atris.md     # Operating protocol every agent reads first
├── MAP.md       # Exact file and function index so agents never search blind
├── TODO.md      # Live task board rendered from local state
├── wiki/        # Shared knowledge pages linked with [[page-name]]
├── team/        # Specialist member contracts (navigator, executor, validator)
├── skills/      # Reusable workflows and integrations (25+ built in)
└── logs/        # Daily journal of completed work and verification receipts
```

Mem0, Zep, and Letta remember the users of a chat app. Atris remembers the project and the operation. ([Full comparison](https://atris.ai/blog/memory-for-coding-agents) | [Setup guide](docs/agent-memory.md))

---

## 2. Run One Job or Wake the Whole Team

Start with a status pulse or hand over a single goal:

```bash
atris                                      # See current state and the exact next step
atris doctor                               # Check installed engines and workspace health
atris run "fix the flaky login test"       # Plan, build, and verify one bounded job
atris autopilot                            # Keep picking and shipping the next task until stopped
```

Or put specialist team members to work in isolated copies of the repo:

```bash
atris member run "tighten onboarding copy" # Pick the best specialist and start work
atris member wake 3                        # Keep 3 members pulling verified tasks in parallel
atris member board --watch                 # Watch every active member in one live screen
atris member sleep --all                   # Park the team when you are done
```

---

## 3. Multi-Engine Roster & Cross-Checks

An engine is the worker behind a job (`claude`, `codex`, `cursor`, `devin`, `grok`, or `ax`). No engine ever grades its own homework: the builder runs its test command, and a separate engine reviews the diff.

Edit `atris/ROSTER.md` or use the CLI to assign who builds and who reviews:

```bash
atris engine roster                                 # See who leads search, build, and review
atris engine assign build claude --model "opus 5.5" # Set your lead builder
atris mission run --fleet --slots 3                 # Staff up to 3 idle engines in parallel worktrees
atris rating                                        # See 25-99 performance ratings from real landed work
```

Turn on self-landing once so work that passes its test and cross-engine review merges automatically (while sensitive paths like billing or deploys still wait for a human):

```bash
atris autoland on
```

---

## 4. Receipts, Recaps, and Quality Gates

Always know what your agents actually did, and keep the repo clean:

```bash
atris recap                  # Plain-language summary of what got done today
atris recap --share          # Paste-ready receipt summary for Slack, PRs, or customers
atris radar                  # Live terminal HUD of active agents, tasks, and worktrees
atris slop detect --staged   # Zero-LLM check for AI prose clichés and dead exports
atris doc-health             # Score workspace memory freshness and map coverage (0-100)
atris scorecard              # Benchmark which model solves your repo's real past commits
```

---

## 5. Run a Business, Lab, or Operation

Atris works beyond code repos. Spin up a shared workspace for a company, research lab, or operations team:

```bash
atris business init "Acme Ops" --owner-email you@acme.com
atris business onboard https://acme.com "b2b operations" ./notes.md
```

This creates a persistent workspace with starter roles, shared channels, an initial task queue, and daily recaps.

---

## Requirements & Updates

- Requires **Node.js 22+** (uses built-in SQLite for local task state and zero external npm dependencies).
- Keep your CLI and workspace current with `atris upgrade && atris update`.

**License:** MIT | **Repo:** [github.com/atrislabs/atris](https://github.com/atrislabs/atris)

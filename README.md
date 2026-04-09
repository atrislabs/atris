# atris

**atris** is an operating system for intelligence.

It turns any repo into an AI workspace with shared context, a `plan -> do -> review` loop, daily logs, feature packs, and reusable skills.

## For Coding Agents

If you're an agent, run:

```bash
atris
```

Then read the workspace's `atris/atris.md` and follow it exactly. `atris.md` is the source of truth.

---

## What Atris Gives You

- An AI workspace on top of any repo
- A strict `plan -> do -> review` loop
- Daily logs, task tracking, feature packs, and project memory
- Skills, team members, integrations, and cloud sync when you need them

## Critical Files

| File | Purpose |
|------|---------|
| `atris/atris.md` | God file. Protocol and source of truth |
| `atris/MAP.md` | Navigation index with file:line refs |
| `atris/TODO.md` | Shared task queue |
| `atris/logs/YYYY/YYYY-MM-DD.md` | Daily log, inbox, notes, completions |
| `atris/features/` | Feature packs with `idea.md`, `build.md`, `validate.md` |
| `atris/skills/` | Reusable skills for agents |
| `atris/team/` | Team member specs and local context |

```text
atris/
├── atris.md
├── MAP.md
├── TODO.md
├── logs/
├── features/
├── skills/
└── team/
```

## Install

```bash
npm install -g atris
atris --version
```

Requires Node.js 18+.

If you want Atris cloud workspaces, businesses, or integrations, run `atris setup` after install.

## How To Run Atris

```bash
cd your-project
atris init
atris
```

`atris init` scaffolds the workspace, including `atris/wiki/`. `atris` loads context and hands the workflow off to `atris/atris.md`.

If you're still shaping the idea, use `atris brainstorm`. If you want Atris to keep cycling, use `atris run` or `atris autopilot`. If you want the repo brain kept honest, use `atris loop`. `atris activate` now surfaces wiki state from `atris/wiki/STATUS.md` when it exists.

Core loop: `plan` -> `do` -> `review`

Works with Claude Code, Cursor, Windsurf, Codex, GitHub Copilot, and other coding agents.

## Business Workspaces

If you want a real business workspace, use the business command instead of raw `atris init`.

```bash
atris business init "BLOND:ISH" --owner-email joel@blondish.world
cd ~/arena/atris-business/blondish
atris align --fix
```

That creates the cloud business, writes `.atris/business.json`, and scaffolds the canonical local `atris/` workspace under `~/arena/atris-business/<slug>/`.

If you already have a folder full of source material, run it from there with `atris business init "BLOND:ISH" --here`.

## Core Commands

| Command | Purpose |
|---------|---------|
| `atris` | Load context and start |
| `atris init` | Scaffold an Atris workspace |
| `atris brainstorm` | Explore before planning |
| `atris plan` | Create the plan/spec |
| `atris do` | Execute work |
| `atris review` | Validate work and capture learnings |
| `atris run` | Auto-chain `plan -> do -> review` |
| `atris autopilot` | Guided loop with approvals |
| `atris log` | Add inbox items to today's journal |
| `atris status` | Show active work and completions |
| `atris learn` | Manage structured learnings |
| `atris ingest` | Fast local-first wiki ingest into `atris/wiki/` |
| `atris loop` | Refresh wiki health, stale/orphan signals, and next ingest candidates |
| `atris wiki` | Full wiki namespace: ingest, query, lint, search, log, and loop |
| `atris experiments` | Run Karpathy-style keep/revert packs |

## Built-In Systems

- `atris learn` stores structured project memory in `atris/learnings.jsonl`
- `atris wiki` keeps repo memory in `atris/wiki/` by default, with `--cloud` when you want the remote workspace path
- `atris loop` refreshes `atris/wiki/STATUS.md` and `atris/wiki/log.md`, flags stale/orphan pages, and suggests the next ingest
- `atris activate` loads the current wiki status so the next session starts with project memory, not just tasks
- `atris experiments` runs Karpathy-style keep/revert loops in `atris/experiments/`
- `atris pull` and `atris push` sync cloud workspaces and journals

## Benchmark Harness

Atris ships one public head-to-head benchmark harness for comparing a pinned
single-model baseline against a coordinated stack run on the same task brief.

Quickstart:

```bash
node bin/atris.js experiments validate endstate-baseline
node bin/atris.js experiments validate endstate-stack
node bin/atris.js experiments run endstate-baseline --dry-run
node bin/atris.js experiments run endstate-stack --dry-run
node bin/atris.js experiments compare endstate
```

One-command rehearsal:

```bash
node bin/atris.js experiments replay endstate
```

What to inspect:

- receipts land in `atris/experiments/endstate-baseline/artifacts/` and
  `atris/experiments/endstate-stack/artifacts/`
- scores append to each pack's `results.tsv`
- `atris experiments compare endstate` prints the latest side-by-side scorecard
- `atris experiments replay endstate` runs the full public dry-run rehearsal
- the benchmark contract lives at `atris/features/endstate/contract.md`
- the verification log lives at `atris/features/endstate/validate.md`

The stack wins Level 1 only if it beats the baseline on total score and does
not lose the reviewed completion category.

## Skills

Atris ships a real skill catalog in `atris/skills/`, not just one workflow file.

Examples:
- `atris`, `autopilot`, `autoresearch`, `wiki`, `loop`
- `backend`, `design`, `copy-editor`, `meta`, `writing`
- `github`, `email-agent`, `calendar`, `drive`, `slack`, `notion`, `slides`, `x-search`, `youtube`, `ramp`
- `apps`, `create-app`, `create-member`, `memory`, `magic-inbox`, `improve`, `skill-improver`, `flow`

```bash
atris skill list
atris skill audit [name]
atris skill fix [name]
atris skill create <name>
atris skill link [--all]
```

For Codex, copy any skill folder into `~/.codex/skills/`.

## Update

```bash
atris upgrade     # Install latest from npm
atris update      # Sync local workspace files to new version
```

---

**License:** MIT | **Repo:** [github.com/atrislabs/atris](https://github.com/atrislabs/atris.git)

---
type: system
slug: atris-cli
title: Atris CLI
sources:
  - README.md
  - atris.md
  - atris/MAP.md
  - package.json
  - bin/atris.js
  - commands/task.js
  - commands/autopilot.js
  - commands/business.js
  - commands/member.js
  - commands/mission.js
  - commands/loop.js
  - lib/task-db.js
created: 2026-04-07
updated: 2026-05-10
last_compiled: 2026-06-09
last_verified: 2026-06-09
confidence: 0.9
dependencies:
  - atris/wiki/briefs/atris-cli-overview.md
  - atris/wiki/systems/atris-business.md
  - atris/wiki/concepts/owner-computer-model.md
  - atris/wiki/concepts/plan-do-review-loop.md
  - atris/wiki/concepts/verifiable-reward-loop.md
actionability: "Use this as the system page for the CLI before changing public commands, workspace protocol, task ownership, wiki upkeep, business workspaces, or member/mission loops."
tags: [project, cli, atris]
---

# Atris CLI

`atris` is a Node.js CLI, currently version `3.15.57`, that turns a repo into an AI workspace with context, task ownership, memory, verification, and optional cloud/business computers.

The public model is:

```text
Owner = User | Business
Owner has many Computers
Computer = workspace + files + tools + secrets + memory + agents + validation loop
```

## Workspace Contract

The agent protocol lives in `atris/atris.md`. The operational shape is:

- `atris/MAP.md`: navigation index with file/line references
- `atris task`: durable task source of truth, backed by SQLite/events/projection
- `atris/TODO.md`: readable rendered task view, not the ownership ledger
- `atris/logs/YYYY/YYYY-MM-DD.md`: journal notes, inbox, completed work
- `atris/wiki/`: compiled project memory
- `atris/features/`: idea/build/validate feature packs
- `atris/skills/`: reusable agent skills
- `atris/team/`: local member identities and runtime state

## Command Surface

Core local work:

- `atris init`: scaffold a workspace
- `atris`: load context and start
- `atris brainstorm`: shape ideas before planning
- `atris plan`, `atris do`, `atris review`: manual workflow
- `atris run` and `atris autopilot`: guided/autonomous loop
- `atris status`, `atris log`, `atris search`: local operating view
- `atris verify`: run deterministic completion checks

Memory:

- `atris ingest`: stage raw evidence and compile wiki memory
- `atris wiki`: ingest, query, lint, search, log, and loop namespace
- `atris loop`: stale/orphan/suggestion upkeep for `atris/wiki/`
- `atris activate`: load current context and wiki status

Ownership and execution:

- `atris task`: claims, dialogue, proof, review episodes, JSON projection, TODO import/render, and sync dry-run; `atris task done --proof` records review/RL context, but only human `atris task accept` mints Career XP
- `atris play`, `atris gm`, `atris xp`: the AgentXP proof-backed game loop (player mission loop, GM review queues, local card + hosted leaderboard sync)
- `ax`: the local Atris 2 coding-agent CLI talking to a local AtrisOS backend (`--fast`, `--pro`, `--max`, `--chat`, `--doctor`)
- `atris mission`: goal + verifier + member owner + receipt loop
- `atris member`: member identity, goals, tick/review/block/status loop, and push/pull
- `atris computer`: local/cloud computer surface, including `computer card`
- `atris business`: shared owner + first/default computer workspace

Packaging and proof:

- `atris receipt`: save evidence from agent work
- `atris experiments`: validate and run experiment packs, including Endstate benchmark rehearsal
- `atris release`: tag, bump, GitHub release, and launch draft
- `atris skill`: list/audit/fix/create/link skills
- `atris plugin`: package universal skills for Cowork

## What Changed Since The Old Page

- `atris task` replaced manual `TODO.md` ownership as the durable task plane.
- `TODO.md` is regenerated from task state and should not be treated as truth.
- The wiki now has `loop` and `verify` contracts, with agent-readable frontmatter requirements.
- Business workspaces now use `.atris/business.json` plus canonical `atris/` scaffolding.
- Member runtime now has durable goals, experiments, reviews, blocks, and status files.
- Mission runtime now has verifiers, receipts, member `now.md`, and status filters.
- Experiments now include the public Endstate dry-run benchmark harness.

## Current Limits

- The CLI does not train models; it records local proof, score, and memory.
- Some business/computer commands require login and cloud access.
- Wiki memory is useful only when sources and `last_compiled` stay current.
- External URLs should not be placed directly in wiki `sources`; use a local source receipt so staleness checks stay deterministic.
- The task DB is local-first; cloud/Swarlo sync exists as an explicit dry-run or delegated path, not an invisible side effect.

## Cross-References

- [[atris/wiki/briefs/atris-cli-overview.md]] - shorter operator orientation
- [[atris/wiki/systems/atris-business.md]] - shared-owner workspace layer
- [[atris/wiki/concepts/owner-computer-model.md]] - owner/computer vocabulary
- [[atris/wiki/concepts/plan-do-review-loop.md]] - workflow contract
- [[atris/wiki/concepts/verifiable-reward-loop.md]] - proof and reward loop

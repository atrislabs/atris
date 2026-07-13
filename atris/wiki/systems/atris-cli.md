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
  - commands/codex-goal.js
  - commands/learn.js
  - commands/live.js
  - commands/member.js
  - commands/mission.js
  - commands/loop.js
  - commands/lesson.js
  - commands/pull.js
  - commands/pulse.js
  - commands/push.js
  - commands/radar.js
  - commands/recap.js
  - lib/policy-lessons.js
  - lib/task-db.js
created: 2026-04-07
updated: 2026-06-30
last_compiled: 2026-07-12
last_verified: 2026-06-30
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

`atris` is a Node.js CLI, currently version `3.35.0`, that turns a repo into an AI workspace with context, task ownership, memory, verification, and optional cloud/business computers.

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
- `atris run`: pursue one bounded mission by default; `--legacy` retains the old plan/do/review chain
- `atris autopilot`: keep selecting mission or member legs until stopped; `--legacy` retains the old approval loop
- `atris run logs`: browse glass run logs (phase reasoning persisted to `atris/logs/runs/`)
- `atris run prune-logs`: prune old run logs, keeping the most recent N (default 50; auto-prune to 100 after each run)
- `atris run search`: search phase reasoning across all run logs by keyword, with `--phase` and `--limit` filters
- `atris run stats`: show run log stats — total runs, phase counts, avg durations
- `atris run export`: export all run logs as a JSON bundle for backup or transfer
- `atris run diff`: compare two run logs side by side, showing phase-level differences
- `atris pulse`: install or run the durable overnight heartbeat
- `atris status`, `atris log`, `atris search`: local operating view
- `atris now`: show the current operating truth
- `atris radar`: show live agents joined with tasks, missions, and worktrees
- `atris ctop`: show a process-first live agent CPU and memory view
- `atris recap`: explain what the AI team did in plain English, with `--share` for paste-ready output
- `atris verify`: run deterministic completion checks

Memory:

- `atris learn`: manage structured project learnings
- `atris ingest`: stage raw evidence and compile wiki memory
- `atris wiki`: ingest, query, lint, search, log, and loop namespace
- `atris loop`: stale/orphan/suggestion upkeep for `atris/wiki/`
- `atris activate`: load current context and wiki status

Ownership and execution:

- `atris task`: claims, dialogue, proof, review episodes, JSON projection, TODO import/render, and sync dry-run; agents move proof-backed work to Review with `atris task ready --proof` (the lane checks cited receipts exist and pass on disk), `review-lane-run` drains the queue to certified agent-side, and only human `atris task accept` mints Career XP
- `atris lesson mine`: mines accepted receipts, review episodes, and scorecards into policy lessons that coach agents at `ready` time (policy hints)
- `atris play`, `atris gm`, `atris xp`: the AgentXP proof-backed game loop (player mission loop, GM review queues, local card + hosted leaderboard sync)
- `ax`: the local Atris 2 coding-agent CLI talking to a local AtrisOS backend (`--fast`, `--pro`, `--max`, `--chat`, `--doctor`)
- `atris codex-goal`: inspect or clear a completed native Codex thread goal with a guarded backup and receipt
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
- `atris pull`, `atris push`, `atris live`: explicit cloud workspace sync and live business-brain refresh

## What Changed Since The Old Page

- `atris task` replaced manual `TODO.md` ownership as the durable task plane.
- `atris run` and `atris autopilot` are mission front doors now; their former plan/do/review behaviors remain behind `--legacy`.
- `TODO.md` is regenerated from task state and should not be treated as truth.
- `atris pulse` is now the durable heartbeat for overnight self-improvement, separate from the old session-bound loop.
- `atris now`, `radar`, `ctop`, and `recap` expose live operating truth in human-readable form.
- `atris codex-goal` guards native Codex goal cleanup with backups, row dumps, and receipts.
- `atris learn` is the structured learning surface beside wiki memory.
- `atris pull`, `push`, and `live` make cloud/business sync explicit instead of invisible.
- The wiki now has `loop` and `verify` contracts, with agent-readable frontmatter requirements.
- Business workspaces now use `.atris/business.json` plus canonical `atris/` scaffolding.
- Member runtime now has durable goals, experiments, reviews, blocks, and status files.
- Mission runtime now has verifiers, receipts, member `now.md`, and status filters.
- Experiments now include the public Endstate dry-run benchmark harness.
- The review lane is evidence-gated and self-draining: `ready` proofs that cite receipts are checked against disk, `review-lane-run` certifies agent-side, and mined policy lessons coach the next submission.
- `atris run` now persists phase reasoning (plan/do/review) to `atris/logs/runs/` as glass run logs — inspectable material, not discarded output. Browse with `atris run logs`.

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

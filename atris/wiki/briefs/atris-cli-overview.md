---
type: brief
slug: atris-cli-overview
title: Atris CLI Overview
sources:
  - README.md
  - atris.md
  - atris/MAP.md
  - commands/autopilot.js
  - lib/scorecard.js
  - commands/task.js
  - lib/task-db.js
  - atris/TODO.md
  - package.json
last_compiled: 2026-06-23
last_verified: 2026-06-23
confidence: 0.88
dependencies:
  - atris/wiki/systems/atris-cli.md
  - atris/wiki/concepts/owner-computer-model.md
  - atris/wiki/concepts/plan-do-review-loop.md
  - atris/wiki/concepts/wiki-as-memory-substrate.md
  - atris/wiki/concepts/verifiable-reward-loop.md
actionability: "Use this as the short repo orientation before choosing between task, wiki, member, mission, or experiment work."
created: 2026-04-07
updated: 2026-06-23
tags:
  - cli
  - overview
  - workspace
  - computer
---
# Atris CLI Overview

`atris` is a Node.js CLI that turns any repository into an AI workspace with shared context, durable task state, project memory, and a `plan -> do -> review` loop. The package entrypoint is `bin/atris.js`, the installed binary is `atris`, and package metadata currently reports version `3.16.0`. The repo protocol agents read is `atris/atris.md`; the root `atris.md` explains the generic workspace rules.

## Owner/computer model

The public product model is:

```text
Owner = User | Business
Owner has many Computers
Computer = workspace + files + tools + secrets + memory + agents + validation/RL loop
```

`atris init` creates a repo-level computer for the current owner. `atris business init <name>` creates a shared business owner plus its first/default computer. A business owner can present as a company, lab, collective, community, artist, team, or project; internal schema and command language still use `business` as the shared owner primitive.

## Workspace layers

The computer's working set is split across local layers that compound across sessions:

- `atris/MAP.md` — navigation index with file:line refs
- `atris task` / `.atris/state/tasks.projection.json` — durable local task ledger and compact UI projection
- `atris/TODO.md` — human-readable rendered task board, not the source of truth
- `atris/logs/YYYY/YYYY-MM-DD.md` — daily journal (inbox, notes, completions)
- `atris/features/` — feature packs (`idea.md` → `build.md` → `validate.md`)
- `atris/skills/` — reusable skills agents can invoke
- `atris/team/` — member identity, `MEMBER.md`, `MISSION.md`, goals, logs, and local skills
- `atris/wiki/` — durable memory (people, systems, concepts, briefs)
- `.atris/state/` — append-only mission/task/member runtime state
- `.atris/presidio/` — local-only operating memory when scorecards or sensitive loop notes are generated

`atris/lessons.md` sits alongside as an append-only record the validator harvests after every feature, so failures compound into guidance instead of being forgotten.

## The extended loop

The base move is still `plan -> do -> review`: plan the work, execute it, then validate and capture learning. Around that core, the CLI now wires a broader operating surface: `brainstorm` shapes raw ideas, `task` stores claims/proof/dialogue in SQLite, `autopilot` and `run` can drive loop work through agent subprocesses, `mission` turns durable objectives into verifier-backed receipts, and `loop` checks wiki health for stale pages, orphan pages, and next ingest candidates.

The team-member surface is now part of the usefulness loop. `atris member` keeps `MEMBER.md` as the role contract, `MISSION.md` as the durable purpose, `goals.json` as machine-readable goal/experiment state, `goals.md` as the human readout, and `logs/YYYY-MM-DD.md` as proof history. `goal`, `wake`, `tick`, `block`, `status`, and `review --value 1..5` are the member loop for testing whether a role is producing useful progress or needs operator input.

The verifiable feedback rail is broader than the original endgame-only path. Tasks can carry `Verify:` commands, plan/do/review use the Confidence Gate, autopilot can run checks after review, and scorecard helpers still exist for closed horizons when that rail is active. Current task truth lives in `atris task`; `atris/TODO.md` can be rebuilt with `atris task render`. Agents move proof-backed work to Review with `atris task ready --proof` — the lane verifies cited receipts exist and pass on disk, `review-lane-run` drains the queue to certified agent-side, and policy lessons mined from past receipts (`atris lesson mine`) coach weak proofs at submission time. AgentXP sits on top: `atris play`, `atris gm`, and `atris xp` run the proof-backed game loop, where only human `atris task accept` mints Career XP for the local card or hosted leaderboard. `ax` is the local Atris 2 coding-agent CLI (Fast/Pro/Max lanes against a local AtrisOS backend) for chat-driven workspace work.

The self-improvement rail is `atris/features/endstate/` and the `experiments/` packs beside it: `atris experiments run <slug>` drives focused benchmark tracks (baseline vs. stack) through the same autopilot primitives that ship real work, emitting receipts and `results.tsv` rows so improvements can be measured instead of claimed. The wiki loop (`atris wiki ingest` / `query` / `lint`, checked by `atris loop`) keeps durable knowledge fresh by detecting stale sources and orphan pages, which is how this brief got recompiled in the first place.

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] — the CLI as a system, its capability surface, and what it doesn't do
- [[atris/wiki/concepts/owner-computer-model.md]] — owner/computer model and language guardrails
- [[atris/wiki/concepts/plan-do-review-loop.md]] — the core workflow that shapes every Atris task
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] — what `atris/wiki/` is for and how it sits under the loop
- [[atris/wiki/concepts/verifiable-reward-loop.md]] — public description of the verify-and-score loop

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
  - atris/TODO.md
  - atris/scorecards.md
  - package.json
last_compiled: 2026-04-09
created: 2026-04-07
updated: 2026-04-09
tags:
  - cli
  - overview
  - workspace
---
# Atris CLI Overview

`atris` (v3.1.0) is a Node.js CLI that turns any repository into an AI workspace with a strict operating loop and shared local context. The package entrypoint is `bin/atris.js`, the installed binary is `atris`, and the workspace conventions live under `atris/`. The `atris.md` spec at the workspace root is the protocol agents read — everything else in the loop points back to it.

## Workspace layers

The working set is split across seven layers that compound across sessions:

- `atris/MAP.md` — navigation index with file:line refs
- `atris/TODO.md` — current task queue (target state = 0)
- `atris/logs/YYYY/YYYY-MM-DD.md` — daily journal (inbox, notes, completions)
- `atris/features/` — feature packs (`idea.md` → `build.md` → `validate.md`)
- `atris/skills/` — reusable skills agents can invoke
- `atris/team/` — agent personas (navigator, executor, validator, brainstormer, launcher, researcher)
- `atris/wiki/` — durable memory (people, systems, concepts, briefs)

`atris/lessons.md` sits alongside as an append-only record the validator harvests after every feature, so failures compound into guidance instead of being forgotten.

## The extended loop

The base move is still `plan` → `do` → `review`: navigator plans, executor builds, validator checks. Around that core, the CLI now wires a longer loop: `brainstorm` shapes raw inbox ideas into tasks, `plan`/`do`/`review` executes them step by step, `autopilot` and `run` drive the loop autonomously via `claude -p` subprocesses, and `loop` schedules the recurring heartbeat that keeps the repo brain honest. `autopilot` is endgame-driven — it reads the current horizon from `TODO.md`'s `## Endgame` section and prefers `[endgame]`-tagged backlog tasks over reactive signals, so progress stays pointed at a real target.

As of 2026-04-09, the loop also has a verifiable reward rail. Endgame tasks can carry `Verify:` commands, `autopilot` runs those checks after review, tick summaries record reward, closed horizons append scorecards, and future horizon picks can weight against recent scorecards. Public docs should describe this modestly as a verifiable feedback loop; internally, it is fair to call the repo an RL-style environment around a fixed model because the environment is the codebase plus deterministic checks.

The self-improvement rail is `atris/features/endstate/` and the `experiments/` packs beside it: `atris experiments run <slug>` drives focused benchmark tracks (baseline vs. stack) through the same autopilot primitives that ship real work, emitting receipts and `results.tsv` rows so improvements can be measured instead of claimed. The wiki loop (`atris wiki ingest` / `query` / `lint`, scheduled by `atris loop`) keeps durable knowledge fresh by detecting stale sources and orphan pages, which is how this brief got recompiled in the first place.

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] — the CLI as a system, its capability surface, and what it doesn't do
- [[atris/wiki/concepts/plan-do-review-loop.md]] — the core workflow that shapes every Atris task
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] — what `atris/wiki/` is for and how it sits under the loop
- [[atris/wiki/concepts/verifiable-reward-loop.md]] — why the loop now behaves like a repo-local RL-style environment

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
  - .atris/presidio/scorecards.md
  - package.json
last_compiled: 2026-04-27
created: 2026-04-07
updated: 2026-04-27
tags:
  - cli
  - overview
  - workspace
  - computer
---
# Atris CLI Overview

`atris` is a Node.js CLI that turns any repository into a persistent AI computer with a strict operating loop and shared local context. The package entrypoint is `bin/atris.js`, the installed binary is `atris`, and the workspace conventions live under `atris/`. The `atris.md` spec at the workspace root is the protocol agents read — everything else in the loop points back to it.

## Owner/computer model

The public product model is:

```text
Owner = User | Business
Owner has many Computers
Computer = workspace + files + tools + secrets + memory + agents + validation/RL loop
```

`atris init` creates a repo-level computer for the current owner. `atris business init <name>` creates a shared business owner plus its first/default computer. A business owner can present as a company, lab, collective, community, artist, team, or project; the schema still uses `business` as the shared owner primitive.

## Workspace layers

The computer's working set is split across seven layers that compound across sessions:

- `atris/MAP.md` — navigation index with file:line refs
- `atris/TODO.md` — current task queue (target state = 0)
- `atris/logs/YYYY/YYYY-MM-DD.md` — daily journal (inbox, notes, completions)
- `atris/features/` — feature packs (`idea.md` → `build.md` → `validate.md`)
- `atris/skills/` — reusable skills agents can invoke
- `atris/team/` — agent personas (navigator, executor, validator, brainstormer, launcher, researcher)
- `atris/wiki/` — durable memory (people, systems, concepts, briefs)
- `.atris/presidio/` — local-only operating memory for scorecards and sensitive loop notes

`atris/lessons.md` sits alongside as an append-only record the validator harvests after every feature, so failures compound into guidance instead of being forgotten.

## The extended loop

The base move is still `plan` → `do` → `review`: navigator plans, executor builds, validator checks. Around that core, the CLI now wires a longer loop: `brainstorm` shapes raw inbox ideas into tasks, `plan`/`do`/`review` executes them step by step, `autopilot` and `run` drive the loop autonomously via `claude -p` subprocesses, and `loop` schedules the recurring heartbeat that keeps the repo brain honest. `autopilot` is endgame-driven — it reads the current horizon from `TODO.md`'s `## Endgame` section and prefers `[endgame]`-tagged backlog tasks over reactive signals, so progress stays pointed at a real target.

As of 2026-04-09, the loop also has a verifiable feedback rail. Endgame tasks can carry `Verify:` commands, `autopilot` runs those checks after review, tick summaries record reward, closed horizons append scorecards under `.atris/presidio/`, and future horizon picks can weight against recent scorecards. The public repo should describe that plainly and keep the sensitive operating notes in Presidio.

The self-improvement rail is `atris/features/endstate/` and the `experiments/` packs beside it: `atris experiments run <slug>` drives focused benchmark tracks (baseline vs. stack) through the same autopilot primitives that ship real work, emitting receipts and `results.tsv` rows so improvements can be measured instead of claimed. The wiki loop (`atris wiki ingest` / `query` / `lint`, scheduled by `atris loop`) keeps durable knowledge fresh by detecting stale sources and orphan pages, which is how this brief got recompiled in the first place.

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] — the CLI as a system, its capability surface, and what it doesn't do
- [[atris/wiki/concepts/owner-computer-model.md]] — owner/computer model and language guardrails
- [[atris/wiki/concepts/plan-do-review-loop.md]] — the core workflow that shapes every Atris task
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] — what `atris/wiki/` is for and how it sits under the loop
- [[atris/wiki/concepts/verifiable-reward-loop.md]] — public description of the verify-and-score loop

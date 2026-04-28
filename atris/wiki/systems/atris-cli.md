---
type: entity
slug: atris-cli
title: atris-cli
sources:
  - /Users/keshavrao/arena/atris-cli/README.md
  - /Users/keshavrao/arena/atris-cli/commands/autopilot.js
  - /Users/keshavrao/arena/atris-cli/lib/scorecard.js
  - /Users/keshavrao/arena/atris-cli/commands/business.js
created: 2026-04-07
updated: 2026-04-27
tags: [project, cli, atris]
---

# atris-cli

Node.js CLI that turns any codebase into an AI-navigable computer. The dev-tool layer of the Atris stack — sibling to atris-business (shared owners with persistent computers) and atrisos-backend/web (cloud).

## Product model

The CLI is the public place where the model must be obvious:

```text
Owner = User | Business
Owner has many Computers
Computer = workspace + files + tools + secrets + memory + agents + validation/RL loop
```

Use `business` as the shared owner primitive in commands and metadata. Use `computer` for the persistent execution environment. Use display language like lab, collective, community, artist, team, or project only as packaging around the same business owner.

## What it does

Three primary moves:

1. **Scaffold** project memory: `atris init` creates `atris/` with MAP, TODO, journal, persona, agent specs
2. **Run the loop**: `atris plan` → `atris do` → `atris review` (manual) or `atris run` / `atris autopilot` (autonomous)
3. **Maintain memory**: `atris activate` loads context, `atris log` appends journal, `atris wiki ingest` builds durable knowledge

## Architecture (the bones of the loop)

| Layer | File / dir | What it is |
|---|---|---|
| Spec | `atris.md` | The protocol agents read |
| Navigation | `atris/MAP.md` | Hand/agent-curated index with file:line refs |
| Tasks | `atris/TODO.md` | Current work queue (target = 0) |
| Journal | `atris/logs/YYYY/YYYY-MM-DD.md` | Daily inbox + completed |
| Memory | `atris/wiki/` | Durable knowledge (people/systems/concepts/briefs) |
| Private memory | `.atris/presidio/` | Local-only scorecards, reward notes, and sensitive operating docs |
| Team | `atris/team/` | Agent personas (navigator, executor, validator, etc) |
| Loop | `commands/run.js`, `commands/autopilot.js` | Plan→do→review automation via `claude -p` subprocesses |
| Sibling | `commands/business.js` | Cloud-side shared-owner and computer productization |

## Verifiable reward rail

As of 2026-04-09, atris-cli can close work on deterministic `Verify:` checks and keep local scorecards for future horizon selection. `autopilot` runs those checks after review, tick summaries store reward, and closed horizons append scorecards under `.atris/presidio/` so the history stays local to the operator.

The public surface should describe this modestly as a verifiable feedback loop. Sensitive operating notes, scorecards, and sharper internal framing belong in `.atris/presidio/`, not in the tracked repo wiki.

## Capabilities surface (what atris-cli can do as primitives)

This is the "capabilities" side of the intent→capability→composition loop. Here's its capability set:

- read/scan a codebase and produce MAP.md
- run `claude -p` subprocesses for plan/do/review phases
- ingest sources into a structured wiki
- query the wiki via local agent prompts
- lint the wiki for broken refs / orphans / contradictions
- create + deploy a business owner with a default computer (team + workspace + context) to cloud
- connect skills (slack, github, notion, etc) to a business
- set notification mode (digest/silent/push) on a business
- self-heal MAP.md drift after each run cycle
- auto-push to git after each cycle

## What it does not do (gaps vs Dorsey checklist)

- No live world model — MAP and wiki are agent-curated docs, not embeddings
- No proactive prompting — everything is pull, nothing pushes
- No customer signal monitoring — there are no "customers" in the loop, only the user
- No real-time composition — `do` runs one task at a time, sequentially
- No causal model — wiki captures facts, not causes

## Cross-References

- [[atris/wiki/systems/atris-business.md]] — productized cloud version, has the proactive layer
- [[atris/wiki/concepts/owner-computer-model.md]] — owner/computer vocabulary and schema guidance
- [[atris/wiki/concepts/intent-capability-composition.md]] — the loop atris-cli implements partially
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] — what `atris/wiki/` is for
- [[atris/wiki/concepts/verifiable-reward-loop.md]] — the reward, scorecard, and horizon-weighting rail

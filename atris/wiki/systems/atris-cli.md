---
type: entity
slug: atris-cli
title: atris-cli
sources: [/Users/keshavrao/arena/atris-cli/CLAUDE.md, /Users/keshavrao/arena/atris-cli/commands/, /Users/keshavrao/arena/atris-cli/lib/wiki.js, /Users/keshavrao/arena/atris-cli/commands/business.js]
created: 2026-04-07
updated: 2026-04-07
tags: [project, cli, atris]
---

# atris-cli

Node.js CLI that turns any codebase into an AI-navigable workspace. The dev-tool layer of the Atris stack — sibling to atris-business (AI-native company workspaces) and atrisos-backend/web (cloud).

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
| Team | `atris/team/` | Agent personas (navigator, executor, validator, etc) |
| Loop | `commands/run.js`, `commands/autopilot.js` | Plan→do→review automation via `claude -p` subprocesses |
| Sibling | `commands/business.js` | Cloud-side AI-native company productization |

## Capabilities surface (what atris-cli can do as primitives)

This is the "capabilities" side of the intent→capability→composition loop. Here's its capability set:

- read/scan a codebase and produce MAP.md
- run `claude -p` subprocesses for plan/do/review phases
- ingest sources into a structured wiki
- query the wiki via local agent prompts
- lint the wiki for broken refs / orphans / contradictions
- create + deploy a business (team + workspace + context) to cloud
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
- [[atris/wiki/concepts/intent-capability-composition.md]] — the loop atris-cli implements partially
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] — what `atris/wiki/` is for

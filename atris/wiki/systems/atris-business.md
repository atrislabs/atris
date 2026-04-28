---
type: entity
slug: atris-business
title: atris business (shared owner + computers)
sources: [/Users/keshavrao/arena/atris-cli/commands/business.js]
created: 2026-04-07
updated: 2026-04-28
tags: [product, cloud, atris, computer, groups]
---

# atris business

Atris business is the shared-owner layer inside atris-cli. A `business` is the schema owner for a persistent fleet of computers: workspaces with files, tools, secrets, memory, agents, integrations, and validation loops. The internal owner primitive stays `business`; `entity_type` defines the operating mode, `computer_type` defines the function, and groups define the human surface.

## Product Model Update — 2026-04-27

Treat `business` as the shared owner/container, not as the only kind of customer language.
Under the product model in [[atris/wiki/concepts/owner-computer-model.md]], owners have computers:

```
Owner = User | Business
Business owns many Computers
User owns many Computers
```

The schema can keep `business` as the shared owner while `entity_type` stays constrained to three modes:

- `business` — profit generation
- `research` — truth generation
- `project` — artifact generation

The outward packaging can say business, lab, collective, artist, team, or community, but those are display language or tags.
Do not turn them into base entity types without a distinct reward function.

Computer type carries the function: `business_ops`, `codeops`, `research`, `crm`, `reporting`, `recruiting`, `event_ops`, or `support`.
`atris business init <name>` should be understood as creating the business owner plus its first/default business computer.

Groups carry people, chat, membership, posts, approvals, and visibility.
They attach to owners/computers; they do not replace either one.

## Local shape

```
~/arena/atris-business/<slug>/
├── .atris/business.json   owner/computer binding metadata
├── .atris/state/          events, episodes, scorecards, sync receipts
└── atris/                 the default computer workspace
    ├── MAP.md
    ├── TODO.md
    ├── context/
    ├── team/
    ├── wiki/
    └── reports/
```

`atris business deploy <slug>` pushes this folder to the cloud business owner; the cloud-side computer loop runs against the deployed workspace.

## Legacy template presets

Older product docs describe template presets that ship predefined agents:

| Template | Agents |
|---|---|
| **saas** | growth-hacker, product-analyst, support-agent |
| **agency** | project-manager, researcher, outreach-agent |
| **ecommerce** | inventory-analyst, marketing-agent, support-agent |
| **content** | writer, researcher, social-media-agent |
| **restaurant** | review-responder, social-media-agent, booking-agent |

## Capabilities surface

- `atris business init <name> [--template ...]` — create the shared owner and first/default computer
- `atris business create <name> [--template ...]` — create the cloud business record; add `--workspace` for local scaffold
- `atris business onboard ...` — turn sparse intake or loose files into raw context, starter brief, first workflow, safe next action, and operator brief
- `atris business record <report-path>` — append a completed recap into `.atris/state/events.jsonl`, `episodes.jsonl`, and `scorecards.jsonl`
- `atris business status <slug>` — inspect local/cloud binding state
- `atris business connect <skill> --business <slug>` — wire up integrations (slack, github, notion, etc)
- `atris business notify <digest|silent|push>` — control proactive notification
- `atris business deploy <slug>` — push local workspace to cloud
- `atris business health <slug>` — workspace health, member activity, issues
- `atris business audit` — across all businesses

## Notification modes (the proactive layer)

| Mode | Behavior |
|---|---|
| **digest** | One morning briefing per day |
| **silent** | Log everything, notify nothing |
| **push** | Interrupt on every action (default, noisy) |

This is the **proactive prompting** half of the Dorsey checklist that atris-cli alone is missing.

## Why this matters for the Dorsey thesis

atris-business is the closest thing in this codebase to Dorsey's intelligence-layer architecture:

- **Artifact layer** — workspace + context dirs + connected integrations (slack/github/notion bring in real artifacts)
- **Agent team** — predefined roles, deployed alongside the workspace
- **Proactive layer** — notification modes mean the agents push, not just pull
- **Customer signals** — connected integrations (slack, github) mean real-world signals can drive action

What's still missing here vs Dorsey:
- No real-time composition — agents run on schedules / triggers, not on demand from customer queries
- No automatic roadmap-from-gaps — humans still write BUSINESS.md
- No money signal — Ramp skill exists but isn't wired into the loop yet

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] — the dev tool that scaffolds these
- [[atris/wiki/concepts/owner-computer-model.md]] — schema/product language guardrail
- [[atris/wiki/concepts/intent-capability-composition.md]] — the loop atris-business runs partially

---
type: entity
slug: atris-business
title: atris business (mini-AGI for companies)
sources: [/Users/keshavrao/arena/atris-cli/commands/business.js]
created: 2026-04-07
updated: 2026-04-07
tags: [product, mini-agi, cloud, atris]
---

# atris business

The productized "mini-AGI for companies" inside atris-cli. A `business` in Atris is a self-contained workspace + agent team + connected integrations that runs on Atris cloud. This is the vehicle Keshav is betting on for the Dorsey thesis.

## Local shape

```
atris/business/<slug>/
├── BUSINESS.md   problem the business solves + revenue model
├── context/      knowledge base (the wiki for THIS business)
├── team/         agent personas
└── workspace/    files agents read/write
```

`atris business deploy <slug>` pushes this folder to the cloud business; the cloud-side agent loop runs against the deployed workspace.

## Templates

Each template ships predefined agents:

| Template | Agents |
|---|---|
| **saas** | growth-hacker, product-analyst, support-agent |
| **agency** | project-manager, researcher, outreach-agent |
| **ecommerce** | inventory-analyst, marketing-agent, support-agent |
| **content** | writer, researcher, social-media-agent |
| **restaurant** | review-responder, social-media-agent, booking-agent |

## Capabilities surface

- `atris business create <name> [--template ...]` — scaffold local + cloud
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

## Why this matters for the AGI thesis

atris-business is the closest thing in this codebase to a real mini-AGI:

- **Artifact layer** — workspace + context dirs + connected integrations (slack/github/notion bring in real artifacts)
- **Agent team** — predefined roles, deployed alongside the workspace
- **Proactive layer** — notification modes mean the agents push, not just pull
- **Customer signals** — connected integrations (slack, github) mean real-world signals can drive action

What's still missing here vs Dorsey:
- No real-time composition — agents run on schedules / triggers, not on demand from customer queries
- No automatic roadmap-from-gaps — humans still write BUSINESS.md
- No money signal — Ramp skill exists but isn't wired into the mini-AGI loop yet

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] — the dev tool that scaffolds these
- [[atris/wiki/concepts/mini-agi.md]] — the thesis being implemented
- [[atris/wiki/concepts/intent-capability-composition.md]] — the loop atris-business runs partially
- [[atris/wiki/syntheses/atris-as-mini-agi.md]] — full scoring

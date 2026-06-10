---
type: system
slug: atris-business
title: Atris Business Owner Workspaces
sources:
  - commands/business.js
  - commands/sync.js
  - commands/computer.js
  - README.md
  - atris/MAP.md
created: 2026-04-07
updated: 2026-06-09
last_compiled: 2026-06-09
last_verified: 2026-06-09
confidence: 0.87
dependencies:
  - atris/wiki/concepts/owner-computer-model.md
  - atris/wiki/systems/atris-cli.md
  - atris/wiki/concepts/intent-capability-composition.md
actionability: "Use this before changing `atris business`, business onboarding, business workspace shape, or owner/computer language."
tags: [product, cloud, atris, computer, groups]
---

# Atris Business Owner Workspaces

`atris business` is the shared-owner layer in the CLI. A business owner can be spoken about as a company, lab, collective, community, artist, team, or project, but the command keeps one internal primitive: a shared owner with a first/default computer workspace.

## Current Model

```text
business owner
  -> .atris/business.json
  -> atris/ workspace
  -> context + wiki + team + reports + TODO
  -> optional cloud sync / computer / integrations
```

The product language should follow the owner:

```text
Your business runs on Atris.
Your lab runs on Atris.
Your collective runs on Atris.
```

Do not split those labels into new base entity types unless they have a distinct reward function. The owner/computer split stays:

- Owner: user or business/shared owner.
- Computer: scoped workspace for code, research, CRM, reporting, recruiting, event ops, support, or business ops.
- Group/team: human membership, approvals, chat, roles, and visibility.

## Local Shape

Default target:

```text
~/arena/atris-business/<slug>/
  .atris/business.json
  .atris/state/
  atris/
    MAP.md
    TODO.md
    context/
    team/
    wiki/
    reports/
```

`createCanonicalBusinessWorkspace()` writes `.atris/business.json`, calls `syncBusinessCanonical()` so the starter business workspace comes from `templates/business-starter/` without clobbering custom files, ensures root agent adapters, and writes a runtime receipt via `writeRuntimeReceipt()`.

## Primary Flows

- `atris business init "<name>"` / `workspace`: recommended path; creates the cloud business and local canonical workspace.
- `atris business create "<name>"`: cloud-only by default; add `--workspace`, `--here`, or `--root <dir>` for local scaffold.
- `atris business onboard ...`: creates raw intake, staged sources, a starter brief, optional person page, first-loop concept, cheat sheet, one-pager, and starter TODO entry from sparse input.
- `atris business record <report>`: appends recap state to `.atris/state/events.jsonl`, `episodes.jsonl`, and `scorecards.jsonl`.
- `atris business list --local` / `fleet`: local fleet scan for `~/arena/atris-business/*`.
- `atris business doctor [--fix]`: compares cloud-active businesses with `~/.atris/businesses.json` and local `.atris/business.json` bindings.
- `atris business team|status|health|audit`: cloud inspection commands.
- `atris business start|check|ready`: renders an operating-state start card (tasks, missions, team goals, XP) from local workspace state.
- `atris business share|handoff [--role <r>] [--write|--out <path>]`: renders a collaborator handoff; optionally writes it to `atris/reports/`.
- `atris business connect <service>` and `notify <digest|silent|push>`: integration and proactive-notification controls.
- `atris business deploy <slug>`: legacy push path for `atris/business/<slug>/` content.

## Onboarding Contract

`onboard` is intentionally tolerant of sparse input. It can use:

- `--name` to scaffold `.atris/business.json` in a bare folder
- `--website`, links in notes, and local source files
- `--contact`, `--role`, and `--email`
- loose local files outside `atris/` and `.atris/`

The useful output is not a perfect CRM record. It is a first safe loop:

```text
intake evidence
  -> starter brief
  -> first-loop hypothesis
  -> operator one-pager
  -> starter task
  -> first recap recorded as reward data
```

## Doctor / Fleet Guardrails

`business doctor` is the safer repair path for binding drift. It can fix local cache rows, but it does not rename folders or mutate cloud data.

`business list --local` is pure local. It classifies folders as ready, flat, unbound, nested, bare, or superseded so operators can see which customer/business workspaces are safe to use.

## Relation To The Dorsey Thesis

This system is Atris' owner/computer version of the company-as-intelligence idea:

- artifact layer: local workspace files, context packs, wiki, reports, and task state
- world model seed: starter briefs, first-loop concepts, and recurring recaps
- intelligence/action layer: business computer, integrations, and notification modes
- reward layer: `business record` writes events, episodes, and scorecards

The hard limits are still real:

- No real-time product composition from customer queries yet.
- No automatic roadmap-from-gaps beyond first-loop and recap artifacts.
- Money signal is not wired into the business loop by default.
- Some cloud paths still require login and cannot be validated offline.

## Cross-References

- [[atris/wiki/concepts/owner-computer-model.md]] - schema and product-language guardrail
- [[atris/wiki/systems/atris-cli.md]] - CLI layer that exposes the commands
- [[atris/wiki/concepts/intent-capability-composition.md]] - capability gaps as roadmap signal

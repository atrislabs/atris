---
type: concept
slug: owner-computer-model
title: Owner Computer Model
sources:
  - README.md
  - atris/MAP.md
  - bin/atris.js
  - commands/business.js
  - commands/computer.js
created: 2026-04-27
updated: 2026-05-10
last_compiled: 2026-06-09
last_verified: 2026-06-09
confidence: 0.88
dependencies:
  - atris/wiki/systems/atris-cli.md
  - atris/wiki/systems/atris-business.md
actionability: "Use this before changing owner/computer language, business workspace scaffolding, computer card fields, or public help text."
tags: [product, schema, computer, business, groups]
---

# Owner Computer Model

Atris product language should stay simple: owners have persistent AI computers.

```text
Owner = User | Business
Owner has many Computers
Computer = workspace + files + tools + secrets + memory + agents + validation loop
```

The CLI implementation has one wrinkle: `atris computer card` reports unbound local repos as owner type `project`. Treat that as a local fallback/display state, not a new top-level owner in the product model.

## Owner Boundary

- User-owned computer: personal research, coding, chief-of-staff, life ops, experiments.
- Business-owned computer: shared business data, team permissions, business secrets, workflows, customers, reporting.
- Project fallback: local repo without `.atris/business.json`; useful for a computer card, not a product owner class.

Keep `business` as the shared owner primitive in CLI internals and metadata.

## Shared Owner Language

External language can follow the customer:

```text
Your business runs on Atris.
Your lab runs on Atris.
Your collective runs on Atris.
Your artist team runs on Atris.
```

Those labels should not become base entity types without a distinct reward function and storage need.

## Computer Types

Computer type is the function preset, not an owner class:

- `business_ops`
- `codeops`
- `research`
- `crm`
- `reporting`
- `recruiting`
- `event_ops`
- `support`

Each type can imply default folders, skills, tools, guardrails, secrets, validation templates, and first-loop tasks.

## Business Workspace Implication

`atris business init "<name>"` means:

1. create the shared business owner
2. create or bind the first/default computer workspace
3. write `.atris/business.json`
4. scaffold the local `atris/` workspace under `~/arena/atris-business/<slug>/`, `--here`, or `--root <dir>`

`atris business create "<name>"` is cloud-only unless `--workspace`, `--here`, or `--root` is supplied.

## Group Boundary

Groups are the social/access layer, not a fourth owner type and not a computer.

```text
Owner owns computers.
Computer runs work.
Group controls people, chat, membership, posts, approvals, and visibility.
```

Durable execution memory belongs in the computer. Membership and approval surfaces belong in groups or business/team state.

## Guardrail

Do not add a third top-level owner type now. Use:

- owner: user or business
- local fallback: project
- computer type: job/function
- group: people/access/coordination
- tags/display language: lab, collective, artist, venue, nonprofit, school, team

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] - current public CLI surface
- [[atris/wiki/systems/atris-business.md]] - shared-owner workspace implementation

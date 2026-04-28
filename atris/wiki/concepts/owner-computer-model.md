---
type: concept
slug: owner-computer-model
title: Owner -> Computer Model
sources:
  - in-session product synthesis, 2026-04-27
created: 2026-04-27
updated: 2026-04-28
tags: [product, schema, computer, business, groups]
---

# Owner -> Computer Model

Atris should keep the current business-centered schema, but explain the product as owners having computers.

## Primitive

```
Owner = User | Business

Owner has many Computers.

Computer = workspace + files + tools + secrets + memory + agents + validation/RL loop
```

## Owner Boundary

- A user-owned computer is personal: research, coding, chief-of-staff, life ops, personal experiments.
- A business-owned computer is shared: business data, team permissions, business secrets, workflows, customers, reporting.

Keep `business` as the shared owner in the schema.

## Entity Type

`entity_type` is the owner's operating mode, not a new owner table.

Keep it brutally constrained:

- `business` — profit generation; customers, revenue, operations, reporting, support, growth
- `research` — truth generation; hypotheses, experiments, evidence, papers, benchmarks, grants
- `project` — artifact generation; milestones, scope, tasks, demos, releases

Everything else is display language or tags.
Artist, community, collective, venue, nonprofit, school, and team should not become base entity types until a reward function demands it.

This field can start optional.
If missing, treat the owner as `business` for defaults and filtering.

## Computer Types

Computer type is the function preset, not a new owner class.

- `business_ops`
- `codeops`
- `research`
- `crm`
- `reporting`
- `recruiting`
- `event_ops`
- `support`

Each type should define default folders, skills, tools, guardrails, secret requirements, validation templates, and first-loop TODOs.

## Group Boundary

Groups are the social/access layer, not a fourth owner type and not a computer.

```
Owner owns Computers.
Computer runs work.
Group controls people, chat, membership, posts, approvals, and visibility.
```

Attach groups to owners and computers when humans need to participate.
Do not put durable execution memory in groups; put it in the computer.
Do not put membership, audience, or approval surfaces in the computer; put them in groups.

Examples:

- Parked: owner `business`, computers `crm` / `event_ops` / `reporting`, groups `founders` / `ambassadors` / `vendors` / `subscribers`
- Research lab: owner `research`, computers `literature` / `experiments` / `benchmarks`, groups `PIs` / `students` / `reviewers` / `collaborators`
- Product build: owner `project`, computers `codeops` / `research` / `reporting`, groups `core` / `contributors` / `reviewers`

## CLI Implication

`atris business init "Parked"` should mean:

1. create the shared owner/business
2. create the first/default business computer
3. scaffold the local workspace under `~/arena/atris-business/<slug>/`

Future CLI can add typed computers under an owner:

```bash
atris computer create crm --business parked
atris computer create reporting --business doordash
atris computer create research --owner me
```

Do not add a third top-level owner type yet.
Use `entity_type` for the strict operating mode, `computer_type` for function, and groups for people/access/coordination.

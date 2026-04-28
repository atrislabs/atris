---
type: concept
slug: owner-computer-model
title: Owner -> Computer Model
sources:
  - in-session product synthesis, 2026-04-27
created: 2026-04-27
updated: 2026-04-27
tags: [product, schema, computer, business]
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
A business can externally be called a company, lab, collective, community, artist, team, or project.

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
Use `entity_type` or display language for packaging, and `computer_type` for function.

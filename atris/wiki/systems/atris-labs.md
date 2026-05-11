---
type: system
slug: atris-labs
title: Atris Labs Dogfood Workspace
sources:
  - atris/wiki/sources/atris-labs-2026-05-10.txt
created: 2026-04-08
updated: 2026-05-10
last_compiled: 2026-05-10
last_verified: 2026-05-10
confidence: 0.68
dependencies:
  - atris/wiki/systems/atris-business.md
  - atris/wiki/concepts/owner-computer-model.md
  - atris/wiki/concepts/atris-labs-goals.md
actionability: "Use as dogfood/workspace orientation only; verify live company state in the current atris-customers or business workspace before acting."
tags: [company, workspace, computer, dogfood, atris]
---

# Atris Labs Dogfood Workspace

Atris Labs is the company that builds Atris and the first dogfood target for the owner/computer model. The useful idea is still valid: the company should run through the same memory, context, apps, and proof loops that customers buy.

The old source path in this wiki page no longer exists. Current local evidence is split across:

- `atris-customers/atris-labs/`: historical/customer-style operating context, pipeline, team member files, and fundraising notes.
- `atris-business/atris-labs-1/apps/`: business app definitions such as revenue, customer pulse, burn rate, daily standup, pitch deck, and Atris app surfaces.
- `atrisos-backend/backend/static/workspaces/atris-labs/instructions.md`: backend static workspace instructions.
- `atrisos-backend/backend/atris-labs-1/.atris/business.json`: cloud binding metadata for an Atris Labs business workspace.

## Mission

Prove the operating model by living in it. Atris Labs should be able to answer "what is the company doing right now?" from workspace artifacts instead of Slack archeology or founder memory.

## Current Read

The latest available local status files are historical March 2026 artifacts, not fresh company truth. They still show the shape of the dogfood loop:

- company status and pipeline rollups in `context/`
- team member priorities in `team/<person>/MEMBER.md`
- customer/deal work as explicit pipeline rows
- app surfaces for revenue, pulse, burn, standup, pitch deck, and Atris itself
- backend workspace instructions for apps, groups, files, integrations, and member roles

Do not treat the March pipeline or revenue numbers as current without rechecking the live business workspace.

## What It Is

Atris Labs is a reference shared owner with persistent computers and apps:

```text
Atris Labs owner
  -> business workspace binding
  -> app surfaces
  -> context and team files
  -> company state and pipeline
  -> proof that Atris can run a real operating loop
```

## What It Is Not

- Not the source of truth for product code. Product code lives in the Atris repos.
- Not a guarantee that old pipeline numbers are current.
- Not a single clean workspace today; local evidence is split across customer, business, and backend paths.
- Not a dumping ground. Each surface should exist because a real operator loop needs it.

## Operating Principles

1. Status is the front door, but only if it is freshly generated.
2. Surfaces organize work; state files summarize reality.
3. Team member files should expose priorities and accountability.
4. Business apps should map to real company functions, not demos for their own sake.
5. Sensitive fundraising or customer details require current-source verification before reuse.

## Why This Matters

Atris Labs is the proof case for the product claim: if the company can run itself through Atris, the same owner/computer shape can run a customer. The page should stay conservative because the source trail is split and some files are historical.

## Cross-References

- [[atris/wiki/systems/atris-business.md]] - productized shared-owner workspace layer
- [[atris/wiki/concepts/owner-computer-model.md]] - owner/computer schema and language
- [[atris/wiki/concepts/atris-labs-goals.md]] - historical goals layer on top of this dogfood workspace

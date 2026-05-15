---
type: entity
slug: atris-labs
title: atris labs (business owner dogfood)
sources: [/Users/keshavrao/arena/atris-business/atris-labs/atris/MEMBER.md]
created: 2026-04-08
updated: 2026-04-27
last_compiled: 2026-04-27
tags: [company, workspace, computer, dogfood, atris]
---

# atris labs

The reference implementation of a business owner with persistent computers. Atris Labs builds Atris and runs itself on Atris. Every customer who buys Atris is buying the shape Atris Labs already lives inside.

## Mission

Be the dogfood. Prove the operating model by living in it. The company's brain — status, pipeline, customers, financials, team, knowledge, sales/marketing/recruiting surfaces — sits inside a standalone Atris computer so any agent can answer "what is the company doing right now?" in 60 seconds via `STATUS.md`.

## What it is

A standalone Atris business computer at `arena/atris-business/atris-labs/atris/`. Holds:

- company state (pipeline, financials, customers)
- team identities (`team/<member>/MEMBER.md`)
- workspace surfaces (sales, marketing, recruiting)
- knowledge synthesized from edge writes

The front door is `STATUS.md` — always current, always derived, never source-of-truth.

## What it is NOT

- **Not a fundraising vault.** Cap table and investor convos live in a separate workspace by design (security boundary).
- **Not the product code.** That lives in `arena/atrisos-backend/` and `arena/atrisos-web/`.
- **Not per-customer working files.** Those live under `arena/atris-business/<customer>/`.
- **Not a dumping ground.** Every file justifies its own existence.

## Operating principles

1. **STATUS.md is the front door.** Always current. Always derived. Never source-of-truth.
2. **Surfaces own work, state owns data.** Sales notes go in `workspace/sales/`. The pipeline rollup goes in `state/pipeline.md`.
3. **Humans on the edge, world model in the center** (Dorsey). The synthesis loop reconciles edge writes into the center.
4. **Standard atris layout, no inventions.** Match doordash/pallet shape so atris-cli works against it.
5. **No new surfaces without real work to organize.** Three is enough until it isn't.

## Handoff protocol

When an agent loads this workspace:

1. Read `STATUS.md`
2. Read `MAP.md`
3. Read `TODO.md`
4. If you have a team identity, read `team/<you>/MEMBER.md`
5. Then act.

## Why this matters

atris-labs is the proof that the operating model survives contact with a real company. If atris-cli's MAP/TODO/journal/wiki shape can run the company that builds it, the same shape will run any customer's company. The dogfood IS the demo.

## Cross-references

- [[atris/wiki/systems/atris-business.md]] — the productized version of this shape
- [[atris/wiki/concepts/owner-computer-model.md]] — why Atris Labs remains a business owner even when packaging changes
- [[atris/wiki/concepts/atris-labs-goals.md]] — the goals layer that sits on top

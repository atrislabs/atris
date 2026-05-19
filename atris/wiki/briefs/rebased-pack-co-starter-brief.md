---
type: brief
slug: rebased-pack-co-starter-brief
title: Rebased Pack Co Starter Brief
sources:
  - atris/context/_ingest/2026-05-19T03-50-onboarding/intake.md
  - atris/context/_ingest/2026-05-19T03-50-onboarding/sources.txt
last_compiled: 2026-05-19
last_verified: 2026-05-19
confidence: 0.72
dependencies:
  - atris/wiki/concepts/rebased-pack-co-first-loop.md
  - atris/team/START_HERE.md
actionability: "Use this as the short orientation for the local-only Rebased Pack Co onboarding smoke before running business check or share."
created: 2026-05-19
updated: 2026-05-19
tags:
  - business
  - onboarding
  - starter
---

# Rebased Pack Co Starter Brief

## What We Know

- Rebased Pack Co is a local-only business workspace created as a packaged CLI onboarding smoke.
- The workspace slug is `rebased-pack-co`.
- The captured website is `https://rebased.example`, which should be treated as placeholder evidence until a real site is supplied.
- The captured contact is Rae Rebase at `rae@rebased.example`, also placeholder evidence unless confirmed by the operator.
- The strongest source is the local onboarding intake at `atris/context/_ingest/2026-05-19T03-50-onboarding/intake.md`.

## What This Workspace Is For Now

- Prove that a received business workspace can boot into the Atris OS loop.
- Show a collaborator where to start without reading repo internals.
- Keep Review acceptance human-gated while agents continue executable work.
- Turn the first useful run into a recap, scorecard, and share handoff.

## Unknowns

- Whether Rebased Pack Co represents a real company, a demo customer, or only a CLI smoke workspace.
- The real customer, buyer, revenue motion, and source systems.
- The actual workflow that should create business value.
- Whether this workspace should be connected to a cloud business/workspace id.

## Safe Next Moves

- Run `atris business start` and confirm the workspace names missing readiness plainly.
- Run `atris task reviews --limit 10` to inspect certified Review items without accepting them.
- Run the first loop in `atris/wiki/concepts/rebased-pack-co-first-loop.md`.
- Record the first recap with `atris business record ...`, then regenerate the handoff with `atris business share --write`.

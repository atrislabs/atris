---
type: concept
slug: intent-capability-composition
title: Intent → Capability → Composition Loop
sources: [https://www.youtube.com/watch?v=YTVSwOY19Qs]
created: 2026-04-07
updated: 2026-04-07
tags: [loop, architecture]
---

# Intent → Capability → Composition

The functional loop Dorsey describes for how an AI-native company actually *does work*, not just answers questions.

## The loop

```
INTENT          CAPABILITY         COMPOSITION
(human)    →    (system knows)  →  (intelligence layer
strategy        all primitives      assembles product
goals           the company has     on demand)
```

## How it works at Block

- **Intent** — humans set strategy: "make small businesses healthier"
- **Capabilities** — Block's financial primitives: card issuance, lending, P2P transfers, payroll, inventory, etc
- **Composition** — when a customer asks for something, the intelligence layer tries to compose it from existing primitives in real time
- **Gap → roadmap** — if it cannot compose, the gap *automatically* becomes the engineering roadmap for the missing capability

## The killer move: roadmap from gaps

This is the part traditional companies don't have. Normally:

```
PMs gather requirements → write roadmap → engineers build → ship → measure
        (months)             (weeks)       (months)       (release)
```

Dorsey's version:

```
customer asks → intelligence tries to compose → fails → gap = next priority
   (real-time)        (real-time)                (immediate)
```

The roadmap is no longer a planning document. It's the **negative space** of what the intelligence layer can already do.

## Why this is hard

- Requires the company's capabilities to be **legible** to the system (typed, callable, documented as primitives, not buried in code)
- Requires the system to understand **composition rules** (what combines with what, what's safe)
- Requires customer requests to be **structured enough** to attempt composition

Atris's loop (`plan` → `do` → `review`) is a primitive version of this with humans still in the middle. The wiki + MAP + capabilities surface are the substrate that would let it run autonomously.

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] — current implementation status
- [[atris/wiki/systems/atris-business.md]] — productized version

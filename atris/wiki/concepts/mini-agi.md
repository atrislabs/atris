---
type: concept
slug: mini-agi
title: Mini-AGI (Dorsey Thesis)
sources: [https://www.youtube.com/watch?v=YTVSwOY19Qs]
created: 2026-04-07
updated: 2026-04-07
tags: [agi, org-design, intelligence-layer]
---

# Mini-AGI

Jack Dorsey's framing for what a modern company can become when LLMs are good enough to model the company itself. **Treat the company as a mini-AGI** — an intelligence whose substrate is its own digital artifacts.

> "It really is an intelligence, but it hasn't been structured in the way that's the most efficient or the least lossy in terms of information flow."

## Required components

1. **Artifact layer** — every digital trace (Slack, code, PRs, docs, recorded meetings) is captured automatically as substrate
2. **World model** — an LLM continuously modeling the company over those artifacts
3. **Query interface** — anyone (employee, board member) can talk to the company in real time
4. **Intent → Capability → Composition loop** — humans set intent, system knows capabilities, AGI composes product on demand
5. **Roadmap-from-gaps** — when a customer asks for something the system cannot compose, that gap auto-becomes the engineering roadmap
6. **Agent-augmented ICs** — individual contributors direct fleets of agents (Goose, Claude Code) instead of doing manual work
7. **Proactive prompting** — system watches signals (especially money), prompts customers and internal teams instead of waiting to be asked
8. **Full legibility → causal models → predictability** — everything observable, everything modeled, eventually predictable

## The shape

```
        humans (judgment, taste, intent)
              ▲
              │
   ┌──────────┴──────────┐
   │   Intelligence       │
   │      Layer           │  ← LLM over artifacts
   │                      │
   └──────────┬──────────┘
              │
              ▼
          artifacts
   (slack, code, docs, signals)
```

Pyramid → circle. Hierarchy → intelligence. Reactive → proactive.

## What it is NOT

- Not a chatbot bolted onto Slack
- Not a smarter knowledge base
- Not an assistant for the CEO — it replaces middle management's information-routing function
- Not optional once your competitors do it (Dorsey's bet)

## Quotes worth keeping

> "A company's ultimate limiting factor is its own roadmap. We need to remove that from the equation."

> "Imagine if your company was entirely legible… every aspect of it. We're not far off from that from a data perspective. It's putting the intelligence on top of it and making it useful and then making it proactive."

## Cross-References

- [[atris/wiki/people/jack-dorsey.md]] — author of the thesis
- [[atris/wiki/concepts/intent-capability-composition.md]] — the operating loop
- [[atris/wiki/systems/atris-business.md]] — Atris's product-level attempt at this
- [[atris/wiki/syntheses/atris-as-mini-agi.md]] — scoring atris-cli against this checklist

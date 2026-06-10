---
type: concept
slug: intent-capability-composition
title: Intent Capability Composition Loop
sources:
  - atris/wiki/sources/jack-dorsey-2026-05-10.txt
  - atris/wiki/people/jack-dorsey.md
  - atris/wiki/systems/atris-business.md
  - atris/wiki/systems/atris-cli.md
created: 2026-04-07
updated: 2026-05-10
last_compiled: 2026-06-10
last_verified: 2026-06-10
confidence: 0.84
dependencies:
  - atris/wiki/people/jack-dorsey.md
  - atris/wiki/systems/atris-business.md
  - atris/wiki/concepts/verifiable-reward-loop.md
actionability: "Use this when deciding whether a feature should become a capability primitive, a composed workflow, or a backlog item from a failed composition."
tags: [loop, architecture, capability, composition]
---

# Intent Capability Composition

This is the useful operating loop from the Dorsey/Block thesis, translated into Atris terms. It is about how an AI-native company does work, not how it answers chat questions.

## The Loop

```text
intent
  -> capabilities
  -> composition
  -> customer/user outcome
  -> gap signal
  -> next capability
```

- Intent: human strategy, values, constraints, and taste.
- Capabilities: typed primitives the system can safely call or assemble.
- Composition: intelligence layer combines capabilities for a specific moment.
- Gap signal: failed composition becomes roadmap evidence.

## Block Read

In the Block thesis, capabilities are financial primitives such as payments, lending, card issuance, banking, payroll, and related surfaces. The intelligence layer tries to compose those primitives into the right customer outcome. If it cannot compose the outcome because a primitive is missing, that missing primitive becomes roadmap signal.

The important shift is this:

```text
old path: customer research -> PM roadmap -> build -> ship -> measure
new path: customer intent -> attempted composition -> gap -> build missing primitive
```

That only works if customer signal is high fidelity and the capability layer is legible to the system.

## Atris Translation

Atris has early versions of the same layers:

- Intent: `atris task`, `atris mission`, `atris member`, and operator-approved goals.
- Capabilities: commands, skills, business apps, integrations, verifiers, and workspace files.
- Composition: autopilot, member wake/tick/review, business onboarding, and app/workflow surfaces.
- Gap signal: failed verification, missing source, blocked member experiment, incomplete feature spec, or stale wiki page.
- Roadmap: next task, mission, feature pack, or wiki recompile.

Atris is still not doing real-time customer-query composition. Its current useful form is slower and more inspectable: plan the move, execute it, verify it, write the receipt, then let the next loop use the evidence.

## Requirements

The loop only becomes useful when these are true:

- Artifacts are legible: source files, receipts, tasks, wiki pages, and scorecards can be read by tools.
- Capabilities are typed enough to be selected safely.
- Composition attempts are validated, not just narrated.
- Failed attempts produce durable backlog or lessons.
- Humans keep final judgment for ethics, taste, trust, and high-stakes calls.

## Failure Modes

- Capability theater: naming things as primitives before they are callable or verifiable.
- Roadmap fantasy: treating vague user desire as gap evidence without a failed composition attempt.
- Over-automation: letting the model choose outcomes without a proof loop.
- Source drift: memory pages keep describing old capabilities after commands changed.

## Cross-References

- [[atris/wiki/people/jack-dorsey.md]] - source thesis and guardrails
- [[atris/wiki/systems/atris-business.md]] - shared-owner workspace layer
- [[atris/wiki/systems/atris-cli.md]] - current local capability surface
- [[atris/wiki/concepts/verifiable-reward-loop.md]] - proof loop needed before this can compound

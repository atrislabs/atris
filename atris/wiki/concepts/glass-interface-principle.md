---
type: concept
slug: glass-interface-principle
title: Glass Interface Principle
created: 2026-06-23
updated: 2026-06-23
last_compiled: 2026-06-23
last_verified: 2026-06-23
confidence: 0.9
dependencies:
  - atris/wiki/concepts/plan-do-review-loop.md
  - atris/wiki/concepts/verifiable-reward-loop.md
actionability: "Apply this when designing AI tool interfaces — prefer transparency and inspectability over black-box automation."
tags: [design, ai, craft, transparency]
---

# Glass Interface Principle

> The system should let you see through its work.

## Definition

A **glass interface** is an AI tool design where the system's plans, reasoning,
and intermediate steps are visible and editable by the user. It is the opposite
of a **black box** interface where the user submits a wish and receives an
output with no visibility into the process.

## The Loop

```
try → world answers → notice what's wrong → adjust → build intuition
```

The loop is where craft and taste develop. Glass interfaces keep humans in the
loop. Black boxes remove them.

## Output vs. Material

- **Output** ends the loop. It provides an answer but discourages further
  tinkering.
- **Material** invites the creator back in. It is something to be touched,
  shaped, and owned.

AI tools should treat code, reasoning, and artifacts as **material**, not
output.

## Progressive Disclosure

Glass interfaces don't force users to see everything. They offer **progressive
disclosure**: ignore the details at the surface, or dive into infinite depths
to steer the AI or take over the work manually.

## Where Craft Lives

Craft doesn't disappear with AI — it moves to the **edges of judgment**:

- **Upstream craft:** deciding what to ask for, what to keep, what to refuse.
- **Downstream craft:** taking responsibility for what is released — who it
  serves and what it changes in the world.

## Application in Atris

- **Run logs (CLI-337):** Phase reasoning is persisted to
  `atris/logs/runs/` as inspectable material, not discarded.
- **Proof-on-disk:** Tasks require concrete proof (commands, receipts, file
  changes) — not chat claims.
- **Navigator→Executor→Validator loop:** Each phase is visible, separable,
  and reviewable.
- **MAP.md as navigation:** File:line references keep the codebase
  inspectable, not a black box.

## Anti-Patterns

- "Wishful thinking" interfaces: prompt → finished product, no iteration.
- Hidden reasoning: AI works invisibly, user only sees the result.
- Output-only: no way to inspect, edit, or steer intermediate steps.

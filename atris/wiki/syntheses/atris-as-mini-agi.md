---
type: synthesis
slug: atris-as-mini-agi
title: Is atris-cli a mini-AGI yet?
sources: [
  atris/wiki/people/jack-dorsey.md,
  atris/wiki/systems/atris-cli.md,
  atris/wiki/systems/atris-business.md,
  atris/wiki/concepts/mini-agi.md,
  atris/wiki/concepts/intent-capability-composition.md,
  atris/wiki/concepts/wiki-as-memory-substrate.md
]
created: 2026-04-07
updated: 2026-04-07
tags: [agi, scoring, synthesis]
---

# Is atris-cli a mini-AGI yet?

**Short answer: no, but the skeleton is real and one specific gap is what blocks it.**

## Scoring against the Dorsey checklist

| Component | atris-cli (local) | atris-business (cloud) | Verdict |
|---|---|---|---|
| **Artifact layer** | journal, MAP, TODO, wiki, code | workspace + connected integrations | ✓ both have it |
| **World model** | hand-curated MAP + wiki pages | same + more | ✗ no embeddings, no continuous model |
| **Query interface** | `atris wiki query` (prints prompt) | `/business/{id}/chat` API | ~ partial — local is just a prompt, cloud is real |
| **Intent → Capability → Composition** | `plan` → `do` → `review` | same + cloud loop | ~ loop exists, composition isn't real-time |
| **Roadmap from gaps** | manual TODO.md | manual BUSINESS.md | ✗ no auto-detection of capability gaps |
| **Agent-augmented ICs** | autopilot, claude -p subprocesses | cloud agent team per business | ✓ both have it |
| **Proactive prompting** | none (everything is pull) | digest/silent/push notification modes | atris-cli ✗, atris-business ✓ |
| **Causal model / predictability** | none | none | ✗ neither |
| **Money signal** | none | Ramp skill exists, not wired in | ✗ both |

## Score: 3 of 9 fully present; 2 partial; 4 missing

Local atris-cli is roughly **30–40% of the Dorsey checklist**. atris-business is closer to **50%** because it adds the proactive layer and real customer signals (slack/github integrations).

## The single blocking gap

Of the four missing pieces (world model, roadmap-from-gaps, causal model, money signal), the **world model** is the chokepoint. Without it, none of the others are achievable:

- No proactive prompting without a model that knows what's "interesting"
- No roadmap-from-gaps without a model of capabilities
- No causal model without a model period
- Money signal is useless without a model to interpret it

The wiki is the *manual seed* of a world model. To become a real one it needs:

1. **Continuous ingestion** — something that watches journal/code/MAP changes and auto-updates wiki pages, instead of waiting for an agent to be told "ingest this"
2. **Semantic retrieval** — `atris wiki query` should find pages by meaning, not just by an agent reading `index.md` and guessing
3. **A `capabilities.md` page** — explicit, machine-readable list of what atris-cli/atris-business *can do as primitives*. Without this, intent → composition can't even attempt to run.

## What atris already has that's underused

- The journal is a continuous artifact stream, but nothing pipes it into the wiki
- The MAP is a structured index, but it doesn't link out to wiki pages
- The autopilot loop already runs `claude -p` subprocesses; it could trigger a wiki ingest after every cycle for free
- atris-business notification modes are a working proactive layer — but only for human-facing notifications, not for triggering AGI moves

## The shortest path to a real mini-AGI loop

```
artifact change   →   wiki auto-update   →   capability surface refresh
       ↑                                              │
       │                                              ▼
   agent acts    ←   intent + composition  ←   query / signal
```

Concretely, the missing pieces in priority order:

1. **`capabilities.md`** in each wiki — explicit list of primitives (the hardest part of intent→composition is just *naming* what the system can do)
2. **Auto-ingest hook** — after `atris run` / `atris autopilot` cycles, automatically ingest the new journal entries into the wiki
3. **Proactive surfacing in atris-cli** — even just a daily `atris briefing` that reads the wiki + journal + TODO and pushes a digest, mirroring atris-business notification modes
4. **Real semantic query** — eventually replace the "agent reads index.md" pattern with embeddings, but this is a later move; the first three deliver more value

## Honest assessment

atris-cli is a **scaffolding for mini-AGIs**, not a mini-AGI itself. atris-business is one step closer because it has the proactive layer. The wiki is the missing memory floor — and the moment it has continuous ingestion and a `capabilities.md`, the whole stack jumps from "skeleton" to "minimum viable mini-AGI."

We are **one good loop away**, not five.

## Cross-References

- [[atris/wiki/people/jack-dorsey.md]] — author of the checklist we're scoring against
- [[atris/wiki/concepts/mini-agi.md]] — the components we're scoring
- [[atris/wiki/concepts/intent-capability-composition.md]] — the loop that needs `capabilities.md` to actually run
- [[atris/wiki/systems/atris-cli.md]] — current state
- [[atris/wiki/systems/atris-business.md]] — closer to the goal
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] — the layer that needs continuous ingestion

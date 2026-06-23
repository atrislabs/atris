---
type: concept
slug: agent-activation-contract
title: Agent Activation Contract
sources:
  - atris/CLAUDE.md
  - commands/activate.js
last_compiled: 2026-06-23
last_verified: 2026-06-23
confidence: 0.9
dependencies:
  - atris/wiki/concepts/plan-do-review-loop.md
  - atris/wiki/concepts/wiki-as-memory-substrate.md
actionability: "Use this before changing agent boot instructions, `atris activate`, MAP-first behavior, first-message requirements, or durable-memory routing."
created: 2026-05-10
updated: 2026-06-23
tags:
  - agent-activation
  - protocol
  - mapfirst
---
# Agent Activation Contract

`atris/CLAUDE.md` is the editor-facing boot contract for agents entering an Atris-managed project. `commands/activate.js` is the runtime context panel agents use after that boot. Together they define what "activation" means before responding or editing.

## Boot Sequence

```text
first message -> atris atris.md
setup -> PERSONA + activate + wiki STATUS
navigation -> MAP first, then one grep if needed
work -> plan -> do -> review
memory -> wiki or ingest durable knowledge
```

The first response path is explicit: run `atris atris.md`, show the welcome visualization, then answer. After that, agents load `atris/PERSONA.md`, run `atris activate`, and treat `atris/wiki/STATUS.md` as the current memory snapshot when it exists.

## Runtime Activation

`atris activate` refuses to run without an `atris/` folder and tells the operator to run `atris init` first. In a valid workspace it creates today's journal if missing, detects workspace state, loads current task context, reads `atris/wiki/STATUS.md`, and prints a narrow activation card.

The activation card can include:

- a handoff block from today's journal when `## Handoff` has structured context,
- the last three deduped completions from journal history,
- the current state summary from detected in-progress, backlog, and inbox items,
- a learning count from `atris/learnings.jsonl`,
- wiki health from `atris/wiki/STATUS.md`,
- core file paths for persona, MAP, task view, journal, and wiki status.

The command ends by pointing the operator back to `atris plan -> do -> review` or `atris log`. It is a read/load surface with one deliberate local side effect: ensuring the current journal file exists so the session is writable.

## MAP-First Rule

Before any file search, read `atris/MAP.md` and search the map for the target keyword. If the map has the location, go directly to that file and line. If not, grep once and update `MAP.md` so the next agent does not repeat the same scan.

## Core Truth Surfaces

- `atris/MAP.md` is navigation.
- `atris/TODO.md` is the visible work queue; current task ownership lives in `atris task`.
- `atris/logs/YYYY/YYYY-MM-DD.md` is the operating journal.
- `atris/wiki/STATUS.md` is the current memory snapshot.
- `atris/wiki/index.md` is the durable knowledge index.
- `atris/atris.md` is the full protocol.

## Execution Contract

Work follows `atris plan -> atris do -> atris review`. Planning requires an ASCII visualization and an approval gate. Execution is step-by-step, with verification as reality changes. Completed tasks should be removed from the active queue; the target state is zero stale tasks.

Durable project knowledge belongs in `atris/wiki/` or through the local wiki flow. Ephemeral progress belongs in task state and the daily journal, not in ad hoc context.

`atris/CLAUDE.md` now also carries an explicit agent contract: before edits, claim or create one small task with `atris task` and write the goal/files/done/check contract into task dialogue; after edits, move proof-backed work to Review with `atris task ready <id> --proof "..."`. Proof-ready and human accept are separate gates: an agent's native goal can complete once proof is in Review, but only a human-run `atris task accept <id>` marks the task Done and awards AgentXP. Work that should outlive the chat runs through `atris mission` (start with a verifier, bounded step, `mission tick --verify`, then complete or continue).

## Limits

This page summarizes the activation contract only. Use `atris/atris.md` for the complete protocol, `atris/wiki/concepts/plan-do-review-loop.md` for stage ownership and proof, and `atris/wiki/concepts/wiki-as-memory-substrate.md` for wiki page shape and upkeep behavior. `atris activate` reports state; it does not claim tasks, finish work, or repair broken wiki pages.

## Cross-References

- [[atris/wiki/concepts/plan-do-review-loop.md]] - stage ownership, proof, and review closure
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] - durable memory routing and wiki verification

---
type: brief
slug: atris-labs-workspace-protocol
title: Atris Labs Workspace Protocol
sources:
  - /Users/keshavrao/arena/atris-business/atris-labs/atris/atris.md
last_compiled: 2026-04-27
created: 2026-04-08
updated: 2026-04-27
tags:
  - atris-labs
  - workspace
  - computer
  - protocol
  - dogfooding
---
# Atris Labs Workspace Protocol

Atris Labs is the business owner for the company that builds Atris. Its default computer lives at `arena/atris-business/atris-labs/atris/` and dogfoods the AI-native operating shape before customers touch it. Older docs call this a workspace; in the current product model, the workspace is the filesystem inside the computer.

Model mapping:

```text
Owner: Atris Labs business
Computer: default business_ops computer
Workspace: the files and folders under atris/
```

## On Load

Any agent loading this workspace reads, in order:

1. `STATUS.md` — current company state in one page
2. `MAP.md` — index of everything in this workspace
3. `TODO.md` — active cross-surface tasks
4. `team/<you>/MEMBER.md` — your team identity (if assigned)
5. `MEMBER.md` and `persona.md` — the workspace's own identity in the Atris fleet

## The Loop

Every operating session is plan → do → review:

- **plan** — read STATUS, surface what matters, write to TODO
- **do** — execute the work; outputs land in `workspace/`, journal in `logs/YYYY-MM-DD.md`
- **review** — fold learnings into `wiki/`, update `state/`, regenerate `STATUS.md`

`STATUS.md` is the front door but is **derived**, not source-of-truth. It is regenerated from `state/`, which is derived from work captured in `workspace/` and the surfaces. Never hand-edit STATUS.md as source — update the underlying state and let it recompile.

## Layout

| Path | Role |
|------|------|
| `STATUS.md` | One-page board-readable snapshot. The front door. |
| `MAP.md` | Index of everything in the workspace. |
| `TODO.md` | Active cross-surface tasks. |
| `MEMBER.md` / `persona.md` | This workspace as a member of the Atris fleet. |
| `goals.md` | Company-level goals. |
| `memory.md` | Persistent context for the workspace agent. |
| `instructions.md` | Standing orders for any agent loading the workspace. |
| `state/` | Derived canonical state — pipeline, customers, financials, team. |
| `team/` | Humans + AI agents who work here. Each has a MEMBER.md. |
| `wiki/` | Company brain — theses, frameworks, decisions, learnings. |
| `workspace/` | Where work happens. Surfaces live here. |
| `skills/` | Workspace-specific skills. |
| `reports/` | Generated outputs (briefs, decks, exports). |
| `policies/` | Safety and operating policies for this workspace. |
| `context/` | Per-session context bundles loaded by agents. |
| `logs/` | Daily company journal. |
| `_archive/` | Old structure preserved for reference. |

## Surfaces

Inside `workspace/`, surfaces are operational areas — cross-customer / cross-channel rollups, not per-customer detail (per-customer work lives under `atris-business/{customer}/`).

- `workspace/sales/` — pipeline, motion, sales wedge, what's working
- `workspace/marketing/` — positioning, content, channels, narrative
- `workspace/recruiting/` — open roles, candidate pipeline, hiring strategy

Surfaces are owned by team members (Head of Revenue, CMO, Head of Talent). New surfaces are added only when there is real work to organize — structure follows demand, not speculation.

## North Star

When a Sequoia partner walks in, you open `STATUS.md` and they interrogate the company in real time. That is the demo. That is the fundraise unlock. Every choice in the workspace is judged against whether it makes that future possible.

## Cross-References

- [[atris/wiki/concepts/owner-computer-model.md]] — owner/computer model used by this protocol
- [[atris/wiki/systems/atris-labs.md]] — Atris Labs as the dogfood business owner

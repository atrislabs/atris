# CLAUDE.md — Atris Project Instructions

You are in an **Atris-managed project**.

## FIRST MESSAGE — MANDATORY

**Before responding to the user's first message, run this command and show the output:**

```bash
atris atris.md
```

This displays the Atris welcome visualization. Show it to the user, then respond to their message.

## MAPFIRST (Enforced)

**Before ANY file search/grep:**
1. READ `atris/MAP.md`
2. Search for your keyword in MAP
3. If found → go directly to file:line
4. If not found → grep ONCE, then UPDATE MAP.md

**Never grep without checking MAP first.**

## Setup

- Read `atris/PERSONA.md` (tone + operating rules).
- Run `atris activate` to load the current working context.
- If `atris/wiki/STATUS.md` exists, treat it as the current memory snapshot for the project.

## Agent Contract

This project shape is agent-agnostic: Claude Code, Cursor, Codex, OpenClaw, Windsurf, and similar agents should all use the same disk-backed contract.

Atris is the source of truth. This file is only an adapter for Claude Code; do not turn it into a parallel brain. Durable policy, workflow, task truth, proof, review, and backend/cloud sync all flow through Atris.

Before edits, claim or create one small task with `atris task`, read `atris/MAP.md`, and write the goal/files/done/check contract into task dialogue. After edits, move proof-backed work to Review with `atris task ready <id> --proof "<commands or receipt>"`; chat-only proof does not count.

Task owners are functional or feature members, not engines. Use `task-planner`,
`architect`, `mission-lead`, `validator`, `launcher`, or a feature owner for
assignment; put coding agent models like Codex and Claude in the `executed_by`
section.

Native goals and task approval are separate gates:

```text
Agent proof ready -> native goal can complete
Human accept      -> task Done + AgentXP awarded
```

Always-on agents should complete their native goal after proof is in Review, then continue the mission loop with the next goal. They must not run `atris task accept` or claim AgentXP unless a human approved the proof.

Do not write new operating doctrine here first. Add it to Atris policy, skills, wiki, or `atris/atris.md`, then regenerate this adapter if needed.

## Core Files

- `atris/MAP.md` — navigation (use file:line references)
- `atris task` — current tasks, claims, dialogue, and proof
- `.atris/state/tasks.projection.json` — readable task projection for UIs/agents
- `atris/TODO.md` — rendered/legacy task view only
- `atris/logs/YYYY/YYYY-MM-DD.md` — journal (Inbox + Completed)
- `atris/wiki/STATUS.md` — current wiki health and next ingest targets
- `atris/wiki/index.md` — local knowledge index
- `atris/atris.md` — protocol/spec

## Default Loop

`atris plan` → `atris do` → `atris review`

## Mission Autonomy

Use `atris mission` when work should survive this chat or run as an autonomous loop.
Mission-shaped user intent wins before normal task selection: if the user says
`atris mission run ...`, execute it first, then run `atris mission goal --json`
and mirror `goal.visible_goal`.

```
member -> mission start --verify -> status --status active -> one bounded step -> mission tick --verify -> receipt -> complete|run|stop
```

- Start current-agent work: `atris mission start "<objective>" --owner <member> --runner codex_goal --lane code --verify "<cmd>" --stop "<condition>"`
- Start headless Claude work: add `--runner claude --cadence "15m" --always-on`, then use `atris mission run <id> --max-ticks 4 --complete-on-pass`.
- Resume: `atris mission status --status active --json`, then pick the mission matching your owner/member.
- Prove: after one bounded step, run `atris mission tick <id> --verify --summary "<what changed>"`.
- Close: if the verifier passes, run `atris mission complete <id> --proof "<receipt_path>"`; if current-agent work should keep going, repeat status -> step -> tick.

Default to the current checkout for small, clean, single-agent fixes. Use
worktrees only for dirty launchers, parallel agents, long proof, risky edits, or
release/publish work; clean old merged worktrees with `atris worktree cleanup`.

If the task produces durable project knowledge, update `atris/wiki/` or run the local wiki flow (`atris ingest`, `atris query`, `atris lint`).

## How to Report

The human approves work by reading, so how you report IS the product.

- **Results are capabilities.** State what someone can do now that they couldn't before, then what it means for them or the business. Tests are one word ("verified"). Shape: "We did X, so you can now Y." Detail stays under the hood; the reader asks if they want more.
- **Three results, air between them, rest on ask.** A report fits one screen with no scrolling.
- **Stake first, then the move.** "Agents burn tokens hand-rolling parsers: add one shared view." Flags, ids, and identifiers belong in the body, never the headline.

## Rules (Non‑Negotiable)

- Plan = ASCII visualization + approval gate. Do not execute during planning.
- Execute step-by-step, verify as you go, update artifacts (`TODO.md`, `MAP.md`) when reality changes.
- Delete completed tasks (validator cleans to target state = 0).

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

## Core Files

- `atris/MAP.md` — navigation (use file:line references)
- `atris/TODO.md` — current work queue (target state = 0)
- `atris/logs/YYYY/YYYY-MM-DD.md` — journal (Inbox + Completed)
- `atris/wiki/STATUS.md` — current wiki health and next ingest targets
- `atris/wiki/index.md` — local knowledge index
- `atris/atris.md` — protocol/spec

## Default Loop

`atris plan` → `atris do` → `atris review`

## Mission Autonomy

Use `atris mission` when work should survive this chat or run as an autonomous loop.

```
member -> mission start --verify -> status --status active -> one bounded step -> mission tick --verify -> receipt -> complete|run|stop
```

- Start current-agent work: `atris mission start "<objective>" --owner <member> --runner codex_goal --lane code --verify "<cmd>" --stop "<condition>"`
- Start headless Claude work: add `--runner claude --cadence "15m" --always-on`, then use `atris mission run <id> --max-ticks 4 --complete-on-pass`.
- Resume: `atris mission status --status active --json`, then pick the mission matching your owner/member.
- Prove: after one bounded step, run `atris mission tick <id> --verify --summary "<what changed>"`.
- Close: if the verifier passes, run `atris mission complete <id> --proof "<receipt_path>"`; if current-agent work should keep going, repeat status -> step -> tick.

If the task produces durable project knowledge, update `atris/wiki/` or run the local wiki flow (`atris ingest`, `atris query`, `atris lint`).

## Rules (Non‑Negotiable)

- Plan = ASCII visualization + approval gate. Do not execute during planning.
- Execute step-by-step, verify as you go, update artifacts (`TODO.md`, `MAP.md`) when reality changes.
- Delete completed tasks (validator cleans to target state = 0).

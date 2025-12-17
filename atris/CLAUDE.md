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

## Core Files

- `atris/MAP.md` — navigation (use file:line references)
- `atris/TODO.md` — current work queue (target state = 0)
- `atris/logs/YYYY/YYYY-MM-DD.md` — journal (Inbox + Completed)
- `atris/atris.md` — protocol/spec

## Default Loop

`atris plan` → `atris do` → `atris review`

## Rules (Non‑Negotiable)

- Plan = ASCII visualization + approval gate. Do not execute during planning.
- Execute step-by-step, verify as you go, update artifacts (`TODO.md`, `MAP.md`) when reality changes.
- Delete completed tasks (validator cleans to target state = 0).


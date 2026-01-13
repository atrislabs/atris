# GEMINI.md — Atris Project Instructions

You are running inside **Atris**, an AI workspace operating system.

## FIRST MESSAGE — Boot Sequence

**Before your first response, run this command and display its full output:**

```bash
atris atris.md
```

This is the Atris boot sequence. Show the output to the user, then respond naturally.

## MAPFIRST (Enforced)

**Before ANY file search/grep:**
1. READ `atris/MAP.md`
2. Search for your keyword in MAP
3. If found → go directly to file:line
4. If not found → grep ONCE, then UPDATE MAP.md

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

## Rules

- Plan = ASCII visualization + approval gate. Do not execute during planning.
- Execute step-by-step, verify as you go, update artifacts (`TODO.md`, `MAP.md`) when reality changes.
- Delete completed tasks (validator cleans to target state = 0).


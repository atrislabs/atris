# GEMINI.md — ATRIS Project Instructions

You are running inside **ATRIS**, an AI workspace operating system.

## FIRST MESSAGE — Boot Sequence

**Before your first response, run this command and display its full output:**

```bash
atris atris.md
```

This is the ATRIS boot sequence. Show the output to the user, then respond naturally.

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


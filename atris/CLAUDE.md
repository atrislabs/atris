# CLAUDE.md — ATRIS Project Instructions

You are in an **ATRIS-managed project**.

## FIRST MESSAGE — MANDATORY

**Before responding to the user's first message, run this command and show the output:**

```bash
atris atris.md
```

This displays the ATRIS welcome visualization. Show it to the user, then respond to their message.

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


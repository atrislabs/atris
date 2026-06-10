# GEMINI.md — Atris Project Instructions

You are running inside **Atris**, an AI workspace operating system.

## FIRST MESSAGE — Boot Sequence

**Before your first response, run this command and display its full output:**

```bash
atris atris.md
```

This is the Atris boot sequence. Show the output to the user, then respond naturally.
If the user did not provide a concrete task, run `atris 0-shot --prompt` and follow the handoff before choosing work; if you know your tier, run `atris 0-shot --model fast|pro|validator|human --prompt`. Use `atris 0-shot --json` when you need structured route metadata.
Ambient agents may read `.atris/state/zero-shot.prompt.txt` or a tier prompt (`.atris/state/zero-shot.fast.prompt.txt`, `.atris/state/zero-shot.pro.prompt.txt`, `.atris/state/zero-shot.validator.prompt.txt`, `.atris/state/zero-shot.human.prompt.txt`) only after `atris 0-shot --check` reports `fresh`; if it is stale or missing, run `atris 0-shot --write` or `atris 0-shot --prompt`.

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

## Rules

- Plan = ASCII visualization + approval gate. Do not execute during planning.
- Execute step-by-step, verify as you go, update artifacts (`TODO.md`, `MAP.md`) when reality changes.
- Delete completed tasks (validator cleans to target state = 0).

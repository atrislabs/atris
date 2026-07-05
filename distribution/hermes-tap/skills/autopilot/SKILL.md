---
name: autopilot
description: Run one bounded Atris autonomy step. Use when the user says autopilot, run one tick, do the next thing, keep going, or make progress without losing proof.
version: 1.0.0
tags:
  - autonomy
  - missions
  - workflow
  - proof
---

# Autopilot

Use this skill to turn vague momentum into one bounded mission step with proof. Do not loop forever inside the chat.

## Start

1. Confirm the repo has Atris:

```bash
test -d atris || npx -y atris init
```

2. Read `atris/atris.md` and `atris/MAP.md`.
3. If the user gave a concrete objective, start or continue a mission:

```bash
atris mission run "<objective>" --owner <member>
```

4. If a mission already exists, inspect it:

```bash
atris mission status --status active --json
atris mission goal --json
```

## One Tick

Run one bounded step only:

1. Pick the active mission that matches the user's request.
2. Identify the next task, file scope, done condition, and verifier.
3. Execute the smallest useful slice.
4. Tick the mission with proof:

```bash
atris mission tick <id> --verify --summary "<what changed>"
```

5. If the verifier passes and the stop condition is met, close it:

```bash
atris mission complete <id> --proof "<receipt or verifier>"
```

If the verifier fails, leave the mission running or blocked with the failure stated plainly.

## Portable Commands

- `atris mission run "<objective>" --owner <member>` starts durable autonomous work.
- `atris mission status --status active --json` shows active work.
- `atris mission goal --json` exposes the current mission goal for runtimes that support visible goal mirroring.
- `atris mission tick <id> --verify --summary "<summary>"` records one proof-bearing step.
- `atris autopilot --dry-run` previews the older task-queue autopilot when available.
- `atris autopilot --auto --iterations=1` runs one legacy queue tick when the repo uses that flow.

## Rules

- One bounded step at a time.
- Prefer mission proof over chat summaries.
- Never mark human acceptance yourself.
- Do not start a recurring scheduler from this skill.
- Stop after one tick unless the user explicitly asks for another.


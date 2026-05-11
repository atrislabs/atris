# AGENTS.md — atris_team

Instructions for coding agents working inside this repository.

## Workflow (Default)

1. Read `atris/PERSONA.md` and follow it (anti-slop, 3–4 sentences, ASCII for planning).
2. Run `atris activate` to load the current working context.
3. Use `atris/MAP.md` for navigation (file:line refs) when present.
4. Track work in `atris/TODO.md` (target state = 0).
5. Preferred loop: `atris plan` → `atris do` → `atris review`.

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

## Repo Layout

- `bin/atris.js` — CLI entrypoint + routing + natural-language entry.
- `commands/` — most command implementations.
- `lib/` — journal/task/file helpers (`journal`, `file-ops`, `state-detection`).
- `utils/` — auth/API/config/update-check and cloud execution helpers.
- `atris.md` — master spec template copied into user projects.

## Notes

- `TODO.md` is the current task file; `TASK_CONTEXTS.md` is legacy (fallback only).
- Feature templates live in `atris/features/_templates/` (`idea`, `build`, `validate`, optional `changelog`).

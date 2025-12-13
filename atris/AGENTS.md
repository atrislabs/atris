# AGENTS.md — atris_team

Instructions for coding agents working inside this repository.

## Workflow (Default)

1. Read `atris/PERSONA.md` and follow it (anti-slop, 3–4 sentences, ASCII for planning).
2. Run `atris activate` to load the current working context.
3. Use `atris/MAP.md` for navigation (file:line refs) when present.
4. Track work in `atris/TODO.md` (target state = 0).
5. Preferred loop: `atris plan` → `atris do` → `atris review`.

## Repo Layout

- `bin/atris.js` — CLI entrypoint + routing + natural-language entry.
- `commands/` — most command implementations.
- `lib/` — journal/task/file helpers (`journal`, `file-ops`, `state-detection`).
- `utils/` — auth/API/config/update-check and cloud execution helpers.
- `atris.md` — master spec template copied into user projects.

## Notes

- `TODO.md` is the current task file; `TASK_CONTEXTS.md` is legacy (fallback only).
- Feature templates live in `atris/features/_templates/`.


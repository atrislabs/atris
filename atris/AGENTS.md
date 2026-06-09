# AGENTS.md — atris_team

Instructions for coding agents working inside this repository.

## Workflow (Default)

Atris is the source of truth. This file is only an adapter for agents that read
`AGENTS.md`; do not turn it into a parallel brain. Durable policy, workflow,
task truth, proof, review, and backend/cloud sync all flow through Atris.

1. Read `atris/PERSONA.md` and follow it (anti-slop, 3–4 sentences, ASCII for planning).
2. Run `atris activate` to load the current working context.
3. If the prompt is vague or empty, run `atris zero-shot --json` and follow its returned route before choosing work.
4. Use `atris/MAP.md` for navigation (file:line refs) when present.
5. Track work with `atris task`; use `atris/TODO.md` only as the rendered fallback view.
6. Preferred loop: `atris plan` -> `atris do` -> `atris review`.

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

## Agent Contract

Leave four durable artifacts:

| Artifact | Where |
|----------|-------|
| Objective | `atris task note <id> "Goal / files / done / check"` |
| Navigation | `atris/MAP.md` when a route or file location is learned |
| Change | Small git diff in declared files only |
| Proof ready | `atris task ready <id> --proof "<commands or receipt>"` |
| Human accept | `atris task accept <id>` |

Native goals and task approval are separate gates:

```text
Agent proof ready -> native goal can complete
Human accept      -> task Done + Career XP awarded
```

Always-on agents should move proof-backed work to Review, complete their native
goal, then continue the mission loop with the next goal. They must not run
`atris task accept` or claim Career XP unless a human approved the proof.

Do not write new operating doctrine here first. Add it to Atris policy, skills,
wiki, or `atris/atris.md`, then regenerate this adapter if needed.

## Repo Layout

- `bin/atris.js` — CLI entrypoint + routing + natural-language entry.
- `commands/` — most command implementations.
- `lib/` — journal/task/file helpers (`journal`, `file-ops`, `state-detection`).
- `utils/` — auth/API/config/update-check and cloud execution helpers.
- `atris.md` — master spec template copied into user projects.
- `atris/atris.md` — workspace protocol/backbone.

## Notes

- `TODO.md` is the current task file; `TASK_CONTEXTS.md` is legacy (fallback only).
- Feature templates live in `atris/features/_templates/` (`idea`, `build`, `validate`, optional `changelog`).

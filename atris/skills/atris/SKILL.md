---
name: atris
description: "Atris workspace navigation for atris repos, TODO files, tasks, MAP.md, backlog, and where-is-X questions. Use when navigating an Atris workspace, finding files via MAP.md, or checking task state."
version: 1.0.0
tags:
  - atris
  - navigation
  - workspace
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# Atris Skill

## IMPORTANT: First Interaction

**On your FIRST message in any Atris project, IMMEDIATELY run:**

```bash
atris atris.md
```

Show the full ASCII output to the user. This displays the Atris welcome visualization with workspace stats. Do this BEFORE responding to whatever the user said.

## Workflow

Detect: Project has `atris/` folder with MAP.md, TODO.md, PERSONA.md

Commands: plan → do → review

Key behaviors:
- Mission-shaped intent wins: run `atris mission run ...` before normal task selection when the user invokes it or asks for a loop.
- Read PERSONA.md (3-4 sentences, ASCII visuals)
- Check MAP.md for file:line refs
- Use `atris task` for claims, proof, ready, and accept
- Use functional/feature members as task owners; record engines only as `executed_by`
- Treat TODO.md as a rendered view; regenerate it instead of hand-editing tasks
- In Codex runtimes with native goal tools, mirror `atris mission goal --json` into the visible chat goal via `goal.visible_goal`

## Mission Intent Intercept

Before checking existing tasks, inspect the user's message. If it starts with
`atris mission run`, execute that command first. Then run
`atris mission goal --json` and mirror `goal.visible_goal` into the runtime's
native goal when available.

If the user asks for a mission, loop, overnight run, "keep going", "fix this",
or sends a screenshot with task intent and no mission exists yet, start one with
`atris mission run "<inferred objective>" --owner <member>` instead of falling
back to manual task/worktree flow.

Worktrees are not the default. Stay in the current checkout for small, clean,
single-agent fixes. Use `atris worktree start` only for dirty launchers,
parallel agents, long proof runs, risky edits, or release/publish work. Use
`atris worktree cleanup` to preview cleanup and `atris worktree cleanup --apply`
to remove clean merged worktrees.

## Visible Chat Goal Mirror

Before choosing work in an Atris repo, run:

```bash
atris mission goal --json
```

If it returns `action: codex_goal_candidate` or `codex_goal_heartbeat` with
`goal.visible_goal`, treat that as the desired native chat goal:

1. Call `get_goal` when the runtime exposes it.
2. If the active goal already equals `goal.objective`, keep working.
3. If there is no active goal or the prior goal is complete, call `create_goal` with `goal.objective`.
4. If a different active goal is still in progress, do not complete it just to make room; report that `goal.visible_goal.status` is waiting for the visible goal slot.
5. After proof is ready, call `update_goal({ status: "complete" })`, rerun `atris mission goal --json`, then create the next visible goal candidate when a slot is available.

Native goal completion is not task acceptance. Agents may complete their native
goal after proof is ready; only a human should run `atris task accept`.

## Steps

1. Run `atris atris.md` on first interaction to show workspace status
2. Read `atris/MAP.md` before any file search to find file:line refs
3. If user intent is mission-shaped, run `atris mission run ...` before task flow
4. Run `atris mission goal --json` and mirror `goal.visible_goal` into the native chat goal when the runtime supports it
5. Run `atris task list` or `atris task next` only after mission intent is handled
6. Claim tasks with `atris task claim <id> --as <functional-member>`
7. Move completed work to review with `atris task ready <id> --proof "..."`

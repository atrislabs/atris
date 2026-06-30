# AGENTS.md — Universal Agent Instructions

> Works with: Claude Code, Cursor, Codex, OpenClaw, Windsurf, and any AI coding agent.

## Quick Start

```bash
atris
atris task list --status open
atris task claim <id> --as <agent>
```

Run `atris` first. It prints repo state, the files to read, and the next command.

If there is no existing task, create one before editing:

```bash
atris task new "<small concrete title>" --tag <area>
atris task claim <id> --as <agent>
```

## Core Files

Atris is the source of truth. This file is only an adapter for tools that read
`AGENTS.md`; do not turn it into a parallel brain. Durable policy, workflow,
task truth, proof, review, and backend/cloud sync all flow through Atris.

| File | Purpose |
|------|---------|
| `atris/atris.md` | Protocol/backbone for this workspace |
| `atris/PERSONA.md` | Communication style (read first) |
| `atris task` | Current tasks, claims, dialogue, proof |
| `.atris/state/tasks.projection.json` | Readable task projection for UIs/agents |
| `atris/TODO.md` | Rendered/legacy task view only |
| `atris/MAP.md` | Navigation (where is X?) |

## Agent Contract

Every agent should leave four artifacts another agent can trust:

| Artifact | Where |
|----------|-------|
| Objective | `atris task note <id> "Goal / files / done / check"` |
| Navigation | `atris/MAP.md` when a new route or file location is learned |
| Change | Small git diff in declared files only |
| Proof ready | `atris task ready <id> --proof "<commands or receipt>"` |
| Human accept | `atris task accept <id>` |

Do not rely on chat context. Put the task, file pointers, and proof on disk.
Do not write new operating doctrine here first; add it to Atris policy, skills,
wiki, or `atris/atris.md`, then regenerate this adapter if needed.

Native goals and task approval are separate gates:

```text
Agent proof ready -> native goal can complete
Human accept      -> task Done + AgentXP awarded
```

Always-on agents should move proof-backed work to Review, complete their native
goal, then continue the mission loop with the next goal. They must not run
`atris task accept` or claim AgentXP unless a human approved the proof.

Mission-shaped user intent wins before normal task selection. If the user
message starts with `atris mission run`, execute that command first, then run
`atris mission goal --json` and mirror `goal.visible_goal` into the native chat
goal. If the user asks for a mission, loop, overnight run, "keep going", "fix
this", or sends a screenshot with task intent and no mission exists yet, start
one with `atris mission run "<inferred objective>" --owner <member>` instead of
falling back to manual task/worktree flow.

Codex agents with native goal tools should run `atris mission goal --json`
before choosing work. If the payload includes `goal.visible_goal`, mirror
`goal.objective` into the visible chat goal when the current goal is empty,
complete, or already matching; never complete unrelated active goals just to
make room.

## Workflow

```
PLAN  → atris plan   (break ideas into tasks)
BUILD → atris do     (execute tasks)
CHECK → atris review (verify + cleanup)
```

## Parallel Member Worktrees

Default to the current checkout for small, clean, single-agent fixes. Use an
isolated checkout only when the launcher is dirty, multiple agents may edit in
parallel, proof will run for a long time, the change is risky, or release/publish
work needs a clean tree.

```bash
atris worktree guide
atris worktree start --member <member> --task "<short task>" --claim
atris worktree start --agent <subagent> --task "<short task>"
cd <printed path>
atris worktree ship --message "<commit summary>" --verify "<test command>" --merge
```

This ties member/agent identity, mission/member state, branch name, isolated checkout, optional Swarlo claim, verification, push, PR, and merge together. Use `atris worktree status` before broad staging and `atris worktree cleanup` / `atris worktree cleanup --apply` to remove clean merged worktrees.

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
- Rollout: `atrisos-backend` and `atrisos-web` agents must check active missions before picking work; if no active mission exists and autonomy was requested, create one with owner, verifier, lane, and stop condition first.

## Rules

- [ ] 3-4 sentences max per response
- [ ] Use ASCII visuals for planning
- [ ] Check MAP.md before touching code
- [ ] Run `atris task list` or `atris task next` before picking work
- [ ] Claim tasks with `atris task claim <id> --as <agent>`
- [ ] Move agent-completed work to Review via `atris task ready <id> --proof "..."`
- [ ] Complete native Codex/Claude goals after proof is in Review, so always-on work can continue
- [ ] Only use `atris task accept <id>` when the human has approved the proof
- [ ] Keep durable learning in Atris-owned policy/skill/wiki/task state; keep `AGENTS.md` as a generated/pointer layer
- [ ] Treat `atris/TODO.md` as a rendered view; do not manually use it as the source of truth
- [ ] Use the real business slug from local Atris state; do not hardcode private slugs in generated docs

## Anti-patterns

- Don't explore codebase manually (use MAP.md)
- Don't skip visualization step
- Don't leave stale tasks
- Don't hand-edit TODO.md for active task ownership
- Don't write verbose docs

---

**Protocol:** See `atris/atris.md` for full spec.

<!-- ATRIS_BRAIN_COMPILE:START -->
## Atris Brain Compile

This workspace has a compiled agent brain.

On session start, activate it first:
`atris brain activate --root . --verify`

Load these first:
- `atris/now.md`
- `atris/brain/STATUS.md`
- `atris/brain/self_improvement_ledger.md`
- `.atris/state/chat_scan.latest.json`
- `atris/wiki/concepts/agent-activation-contract.md`
- `atris/skills/atris/SKILL.md`
- `atris/PERSONA.md`
- `atris/MAP.md`
- `atris/TODO.md`
- `atris/wiki/index.md`

First-message rule: lead with the move before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: `<operator>, today is about <move>` -> `I picked this because <why now>` -> `Ready: <draft/proof/context>` -> `Go deeper: <paths>`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.

Re-run after meaningful work:
`atris brain compile --root .`
<!-- ATRIS_BRAIN_COMPILE:END -->

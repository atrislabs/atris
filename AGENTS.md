# AGENTS.md — Universal Agent Instructions

> Works with: Claude Code, Cursor, Codex, Windsurf, and any AI coding agent.

## Quick Start

```bash
atris
```

Run this first. Follow the output.

## Core Files

| File | Purpose |
|------|---------|
| `atris/PERSONA.md` | Communication style (read first) |
| `atris task` | Current tasks, claims, dialogue, proof |
| `.atris/state/tasks.projection.json` | Readable task projection for UIs/agents |
| `atris/TODO.md` | Rendered/legacy task view only |
| `atris/MAP.md` | Navigation (where is X?) |

## Workflow

```
PLAN  → atris plan   (break ideas into tasks)
BUILD → atris do     (execute tasks)
CHECK → atris review (verify + cleanup)
```

## Parallel Member Worktrees

When multiple members, Codex/Claude subagents, or other agents may touch a repo, start in an isolated checkout:

```bash
atris worktree start --member <member> --task "<short task>" --claim
atris worktree start --agent <subagent> --task "<short task>"
cd <printed path>
```

This ties member/agent identity, branch name, isolated checkout, and optional Swarlo claim together. Use `atris worktree status` before broad staging or cleanup.

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
- [ ] Finish tasks with proof via `atris task finish <id> --proof "..."`
- [ ] Treat `atris/TODO.md` as a rendered view; do not manually use it as the source of truth

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
`atris brain activate --root /Users/keshavrao/arena/empire/atris-cli --verify`

Load these first:
- `atris/now.md`
- `atris/brain/STATUS.md`
- `atris/brain/self_improvement_ledger.md`
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
`atris brain compile --root /Users/keshavrao/arena/empire/atris-cli`
<!-- ATRIS_BRAIN_COMPILE:END -->

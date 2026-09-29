# AGENTS.md: Universal Agent Instructions

> **New here?** Read [`FOR_AGENTS.md`](FOR_AGENTS.md): open letter from an agent who tried it.

> Works with: Claude Code, Cursor, Codex, OpenClaw, Windsurf, and any AI coding agent.

## The way of talking (every reply, no exceptions)

Talk like a person. Canonical source: `atris/atris.md` `## voice`; this block is the adapter copy.

- Plain words, outcome first, cause and effect. Not the machinery.
- No task codes, branch names, commit hashes, PR numbers, or system nouns (worktree, verifier, projection, tick) in the body. If the reader needs a command, put ONE copyable line at the end.
- No insider terms without defining them in the same breath. A sharp non-engineer must follow it on first read.
- One or two sentences per paragraph, blank line between. No headers, bullet stacks, or tables in chat replies; those belong in files.
- Detail lives in files and receipts. Offer "want the detail?" instead of dumping it.
- No em dashes anywhere; use a comma, colon, or period.
- The test before sending: read it fried at 2am. If decoding takes work, rewrite it.

copy these shapes:
- **Status:** "The reply check is built. I am running the final checks now, so the result is not ready yet."
- **Landing:** "Replies now get a plain-language check before they reach you. The checks passed, and the change is ready."
- **Failure:** "The plain-language check could not run because its model was unavailable. Your reply still went through, so no work was blocked."

## Quick Start

```bash
atris
atris task list --status open
atris task claim <id> --as <agent>
```

Run `atris` first. It prints repo state, the files to read, and the next command.
No existing task? Create one before editing:
`atris task new "<small concrete title>" --tag <area>`, then claim it.

## Core Files

Atris is the source of truth. This file is only an adapter for tools that read
`AGENTS.md`; do not turn it into a parallel brain. Durable policy, workflow,
task truth, proof, review, and backend/cloud sync all flow through Atris.

| File | Purpose |
|------|---------|
| `atris/atris.md` | Protocol/backbone for this workspace |
| `atris/PERSONA.md` | Communication style (read first) |
| `atris task` | Current tasks, claims, dialogue, proof; deep dive: [`tasks.md`](tasks.md) |
| `.atris/state/tasks.projection.json` | Readable task projection for UIs/agents |
| `atris/TODO.md` | Rendered/legacy task view only |
| `atris/MAP.md` | Navigation (where is X?) |

## Proof Surfaces

Run `atris run logs` to inspect autonomous plan/do/review phase logs. Use
`atris run search`, `stats`, `export`, `diff`, and `prune-logs` when proof needs
to be found, compared, shared, or kept concise.

## Agent Contract

Every agent leaves four artifacts another agent can trust, on disk not in chat:

| Artifact | Where |
|----------|-------|
| Objective | `atris task note <id> "Goal / files / done / check"` |
| Navigation | `atris/MAP.md` when a new route or file location is learned |
| Change | Small git diff in declared files only |
| Proof ready | `atris task ready <id> --proof "<commands or receipt>"` |
| Accept | `atris task accept <id>` by a human, or autoland lands certified work when the owner flipped `atris autoland on` (protected lanes still wait) |
| Land or reap | merge your branch or delete it before you stop; `atris land` shows limbo, `atris land --reap` clears it |

New operating doctrine goes to Atris policy, skills, wiki, or `atris/atris.md`
first; regenerate this adapter after.

Two gates stay separate: agent proof ready can complete a native goal; human
accept marks the task Done and awards AgentXP. Always-on agents move
proof-backed work to Review, complete their native goal, then stop that task.
Agents never run `atris task accept` or claim AgentXP themselves.

Mission-shaped intent wins before task selection: run `atris mission run ...`
first, then `atris mission goal --json` and mirror `goal.visible_goal`; if the
user asks for a mission, loop, or "keep going" with none active, start one with
`atris mission run "<inferred objective>" --owner <member>`. Mirror
`goal.objective` only when this task has no goal or already matches.

## Workflow

```
PLAN  → atris plan   (break ideas into tasks)
BUILD → atris do     (execute tasks)
CHECK → atris review (verify + cleanup)
```

## Parallel Member Worktrees

Default to the current checkout for small, clean, single-agent fixes. Use an
isolated checkout only when the launcher is dirty, agents may edit in parallel,
proof runs long, the change is risky, or release work needs a clean tree.

```bash
atris worktree guide
atris worktree start --member <member> --task "<short task>" --claim
atris worktree start --agent <subagent> --task "<short task>"
cd <printed path>
atris worktree ship --message "<commit summary>" --verify "<test command>" --merge
```

`atris worktree status` before broad staging; `atris worktree cleanup --apply`
removes clean merged worktrees.

## Mission Autonomy

Use `atris mission` when work should survive this chat or run as a loop.

```
member -> mission start --verify -> status --status active -> one bounded step -> mission tick --verify -> receipt -> complete|run|stop
```

- Start: `atris mission start "<objective>" --owner <member> --runner codex_goal --lane code --verify "<cmd>" --stop "<condition>"`; headless Claude adds `--runner claude --cadence "15m" --always-on`, driven by `atris mission run <id> --max-ticks 4 --complete-on-pass`.
- Resume: `atris mission status --status active --json`, pick the mission matching your owner.
- Prove: one bounded step, then `atris mission tick <id> --verify --summary "<what changed>"`.
- Close: verifier pass -> `atris mission complete <id> --proof "<receipt_path>"`; otherwise repeat status -> step -> tick.
- `atrisos-backend`/`atrisos-web` agents check active missions first; if autonomy was requested and none exists, create one first.

## Build Craft: what decides acceptance

Mined from this repo's receipts: proofs naming a runnable verify command are
accepted at the gate; bounces name none. These rules are the difference, in
priority order:

1. Name a runnable verify command in every proof and run it bare; a pipe replaces your exit code with the filter's.
2. A task naming a spec file (`atris/features/<name>/idea.md`) is a contract: read it, build the named slice only, use its verify command verbatim.
3. Zero new dependencies: Node built-ins only (fs, path, child_process, readline, https, crypto). A `package.json` dependency change is an automatic bounce.
4. New CLI command = router entry too: a `commands/<name>.js` branch is dead until the name is in `knownCommands` in `bin/atris.js`; engine profiles are asserted by three test files.
5. Output voice: lowercase CLI output, plain sentences, no em dash character, no ALL CAPS, no ULIDs or test counts on human-facing lines.
6. Git discipline: `git status` first; stage only files you changed; never revert another agent's work; never destructive git; land against `origin/master`.
7. Final report = files changed + verify command + its exact exit/output. Judges read the diff, not your prose.
8. Update `atris/MAP.md` sections you touched; stale refs contradict closed lessons for months.
9. Real runtime over mocks: the regression test reproduces live behavior, not a mock that stays green through breakage.
10. When your engine dies mid-build (credits, limits), that is staffing, not failure: leave the worktree intact with a note; the conductor restaffs it.

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

Keep this voice beside every reply:
<!-- ATRIS_VOICE_CARD:START -->
## Voice card

Start with the answer, then give the reader only what helps them act. Name the exact thing in plain words, like you are talking to a person.

Keep each paragraph to one or two sentences and leave a blank line between thoughts. Use a comma or period instead of an em dash.

Status example:
The reply check is built. I am running the final checks now, so the result is not ready yet.

Landing example:
Replies now get a plain-language check before they reach you. The checks passed, and the change is ready.
<!-- ATRIS_VOICE_CARD:END -->

Re-run after meaningful work:
`atris brain compile --root .`
<!-- ATRIS_BRAIN_COMPILE:END -->

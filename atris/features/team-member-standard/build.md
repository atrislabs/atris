---
last_compiled: 2026-07-03
sources:
  - commands/member.js:211-223 (memberPaths and MISSION.md wiring)
  - commands/member.js:422-452 (member run bridge to Mission Runtime)
  - commands/member.js:2988-3035 (member list)
  - commands/member.js:3043-3146 (member create scaffold)
  - commands/member.js:3540-3870 (goal, goal-from-mission, goal-from-score)
  - commands/member.js:6734-6758 (wake decision and receipts)
  - commands/member.js:6765-7077 (member loop)
  - commands/member.js:7079-7319 (tick, review, block, status)
  - commands/member.js:8112-8237 (member command dispatch and help)
  - commands/mission.js:718-753 (renderMemberNowMarkdown — member now.md rendering)
  - bin/atris.js:1742 (member command route)
  - atris/team/_template/MEMBER.md
  - atris/features/team-member-standard/idea.md
---

# Team Member Standard — Build Spec

> **Status:** implemented and re-verified (local-first member runtime)

## Files Touched

| File | What |
|------|------|
| `commands/member.js` | Member CRUD, cloud sync, mission-derived goals, wake/tick/review loop, status, block, archive |
| `commands/mission.js` | Renders member `now.md` and workspace `atris/status/now.md` from active missions |
| `bin/atris.js:1742` | Routes `atris member <subcommand>` to `memberCommand` |
| `atris/skills/create-member/SKILL.md` | Skill for creating members via conversation |
| `atris/team/_template/MEMBER.md` | Canonical frontmatter template |
| `atris/team/*/MEMBER.md` | Local member identity contracts |
| `atris/team/*/MISSION.md` | Durable member purpose and goal-selection contract |
| `atris/team/*/goals.json` | Machine-readable active goals, experiments, reviews, and value |
| `atris/team/*/goals.md` | Generated human readout for goals and experiments |
| `atris/team/*/logs/*.md` | Dated member receipts |
| `.atris/state/steering.jsonl` | Cross-member steering directives consumed by wake decisions |
| `atris/runs/member-*` | Wake and loop receipts |

## Subcommands

`atris member` dispatches to these handlers in `commands/member.js`:

| Subcommand | Handler | Purpose |
|------------|---------|---------|
| `list` / `ls` | `memberList` | Show all members with role, format, skill/context counts, version |
| `create <name>` / `new` | `memberCreate` | Scaffold directory: `MEMBER.md` + `MISSION.md` + `skills/` + `tools/` + `context/` + `logs/` |
| `activate <name>` | `memberActivate` | Symlink local skills into `~/.claude`, `~/.codex`, `~/.cursor`; print context + permissions |
| `upgrade <name>` | `memberUpgrade` | Convert flat `team/<name>.md` to directory format |
| `push <name>` | `memberPush` | Upload `MEMBER.md` to cloud; writes `agent-id` back into frontmatter on create |
| `pull <name\|agent_id>` | `memberPull` | Download agent as `MEMBER.md`; auto-resolves name -> `agent-id`; syncs remote journal entries |
| `goal <name> "..."` | `memberGoal` | Create or update a durable active goal with acceptance criteria |
| `goal-from-mission <name>` / `mission-goal` | `memberGoalFromMission` | Derive one bounded goal from `MISSION.md` and current member `now.md` |
| `goal-from-score <name>` / `score-goal` | `memberGoalFromScore` | Derive one active self-improvement goal from Team score evidence |
| `wake <name>` | `memberWake` | Decide `tick`, `wait`, `ask`, or `stop` from mission, goals, steering, task evidence, and workspace state |
| `run <name>` | `memberRun` | Run the member's active Mission Runtime through `atris mission run` |
| `loop <name>` | `memberLoop` | Repeat wake on a bounded cadence with a no-overlap lease, stop file, latest status, and receipts |
| `alive <name>` | `memberAlive` | Run `loop` in always-on liveness mode (forces the `--alive` flag) |
| `tick <name>` | `memberTick` | Propose or reuse the next bounded experiment for the active goal |
| `review <name> <id>` | `memberReview` | Accept or discard an experiment with proof, optional value, lesson, and next experiment |
| `block <name> <id>` | `memberBlock` | Mark an experiment blocked with a concrete human/orchestrator ask |
| `status <name>` | `memberStatus` | Show goal, open experiment, value, ask, recent log, and next command |
| `history <name>` | `memberHistory` | Show dated change history of the member's `MEMBER.md`/`SOUL.md` (git-backed, `--limit N`) |
| `supervisor <cmd>` | `memberSupervisorCommand` | Supervisor sub-namespace (`recommendations [--json]`) |
| `objective-generator <cmd>` | `memberObjectiveGeneratorCommand` | Objective-generator sub-namespace (`proposals [--json]`) |
| `generalist <cmd>` | `memberGeneralistCommand` | Generalist sub-namespace (`proof` / `patterns` `[--json]`) |
| `archive <name>` | `memberArchive` | Move a member to `atris/team/_archived/` |
| `purge-archived` | `memberPurgeArchived` | Delete old archived members with explicit confirmation |

## Frontmatter Schema

Aligned with `atris/team/_template/MEMBER.md`:

```yaml
---
name: <slug>
role: <title>
description: <one-line>
version: 1.0.0

skills: []                  # list of skill slugs

permissions:
  can-read: true
  approval-required: []

tools: []

# Added automatically after first push:
# agent-id: <uuid>
---
```

## Scaffolded Layout

`atris member create <name>` creates:

```
atris/team/<name>/
├── MEMBER.md      # frontmatter + persona/workflow/rules
├── MISSION.md     # human-authored North Star and goal-selection contract
├── skills/        # local skills (linked on activate)
├── tools/         # member-specific tools
├── context/       # reference docs surfaced on activate
└── logs/          # dated receipts and goal/review history
```

Runtime commands can then add:

```
atris/team/<name>/
├── goals.json     # durable goal and experiment state
├── goals.md       # generated operator readout
└── now.md         # generated mission runtime view
```

## Push / Pull Round-Trip

- `member push <name>` reads `MEMBER.md`, POSTs to `/agent/import-member`.
  - If frontmatter already has `agent-id`, cloud **updates** that agent.
  - If not, cloud **creates** a new agent and the returned `agent_id` is written back into `MEMBER.md` frontmatter.
- `member pull <name|agent_id>`:
  - Name arg → reads local `MEMBER.md`, resolves `agent-id` from frontmatter (errors if unpushed).
  - GETs `/agent/<id>/export-member`, writes content to `team/<name>/MEMBER.md`.
  - Then GETs `/agent/<id>/export-journal` and writes each returned file into the member directory (preserves relative paths).

## Goal / Wake / Review Loop

The useful runtime path is local-first and proof-gated:

```text
MISSION.md + now.md
  -> atris member goal-from-mission <name>
  -> goals.json / goals.md
  -> atris member wake <name> [--execute --confirm-autonomy-policy]
  -> atris member tick <name>
  -> atris member review <name> <experiment-id> --accept|--discard --proof "..." --value 1..5
  -> atris member status <name>
```

- `goal-from-mission` refuses placeholder missions and creates one active goal from the member North Star.
- `goal-from-score` can replace direction from Team score evidence and supersedes older open experiments.
- `wake` checks mission, active goal, open/blocked experiments, steering directives, task projection evidence, recent receipts, and member-scoped dirty work.
- `loop` repeats wake with a lease so two loops do not run the same member at once.
- `review` refuses missing proof and records optional value/lesson/next experiment.

## What's Done

- [x] MEMBER.md frontmatter schema (`name`, `role`, `description`, `version`, `skills`, `permissions`, `tools`, optional `agent-id`)
- [x] `atris member create <name>` scaffolds `MEMBER.md` + `MISSION.md` + `skills/` + `tools/` + `context/` + `logs/`
- [x] `atris member list` shows all members with role, format, skill/context counts
- [x] `atris member activate <name>` symlinks skills into Claude/Codex/Cursor and prints context, tools, permissions
- [x] `atris member upgrade <name>` converts flat file → directory format
- [x] `atris member push <name>` creates or updates cloud agent; writes `agent-id` back to frontmatter on create
- [x] `atris member pull <name|agent_id>` downloads agent + journal; auto-resolves name via local `agent-id`
- [x] `atris member goal`, `goal-from-mission`, and `goal-from-score` maintain structured goals and generated readouts
- [x] `atris member wake` makes one finite decision with a receipt instead of piling work onto open experiments
- [x] `atris member loop` repeats wake with no-overlap lease, latest status, stop support, and receipts
- [x] `atris member tick`, `review`, `block`, and `status` form the proof loop for useful member work
- [x] `atris member run` bridges active member runtime state into `atris mission run`
- [x] `atris member alive` runs the member loop in always-on liveness mode
- [x] `atris member history` shows git-backed identity history for MEMBER.md / SOUL.md
- [x] Supervisor, objective-generator, and generalist subcommands expose member-specialized readouts
- [x] `atris member archive` and `purge-archived` manage retired member directories
- [x] Members reference shared skills (`atris/skills/`) and local skills (`team/<name>/skills/`)
- [x] Member directories are portable (self-contained)
- [x] Spec is tool-agnostic in design

## What's Not Done

- [ ] Open source spec published separately
- [ ] Cross-tool compatibility verified by external agents reading MEMBER.md

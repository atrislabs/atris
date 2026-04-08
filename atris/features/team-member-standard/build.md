---
last_compiled: 2026-04-07
sources:
  - commands/member.js
  - bin/atris.js
  - atris/team/_template/MEMBER.md
  - atris/features/team-member-standard/idea.md
---

# Team Member Standard — Build Spec

> **Status:** implemented (core)

## Files Touched

| File | What |
|------|------|
| `commands/member.js` | Full member CRUD: `list`, `create`, `activate`, `upgrade`, `push`, `pull` |
| `bin/atris.js:315-318` | Help text for `member create`/`list`/`activate`/`upgrade` |
| `bin/atris.js:1035-1038` | Routes `atris member <subcommand>` to `memberCommand` |
| `atris/skills/create-member/SKILL.md` | Skill for creating members via conversation |
| `atris/team/_template/MEMBER.md` | Canonical frontmatter template |
| `atris/team/*/MEMBER.md` | 6 built-in members: `brainstormer`, `executor`, `launcher`, `navigator`, `researcher`, `validator` |

## Subcommands

`atris member` dispatches to these handlers in `commands/member.js`:

| Subcommand | Handler | Purpose |
|------------|---------|---------|
| `list` / `ls` | `memberList` | Show all members with role, format, skill/context counts, version |
| `create <name>` / `new` | `memberCreate` | Scaffold directory: `MEMBER.md` + `skills/` + `tools/` + `context/` + `journal/` |
| `activate <name>` | `memberActivate` | Symlink local skills into `~/.claude`, `~/.codex`, `~/.cursor`; print context + permissions |
| `upgrade <name>` | `memberUpgrade` | Convert flat `team/<name>.md` to directory format |
| `push <name>` | `memberPush` | Upload `MEMBER.md` to cloud; writes `agent-id` back into frontmatter on create |
| `pull <name\|agent_id>` | `memberPull` | Download agent as `MEMBER.md`; auto-resolves name → `agent-id` via local frontmatter; syncs journal entries back into `team/<name>/journal/` |

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
├── MEMBER.md     # frontmatter + persona/workflow/rules
├── skills/       # local skills (linked on activate)
├── tools/        # member-specific tools
├── context/      # reference docs surfaced on activate
└── journal/      # per-day logs, round-tripped by push/pull
```

## Push / Pull Round-Trip

- `member push <name>` reads `MEMBER.md`, POSTs to `/agent/import-member`.
  - If frontmatter already has `agent-id`, cloud **updates** that agent.
  - If not, cloud **creates** a new agent and the returned `agent_id` is written back into `MEMBER.md` frontmatter.
- `member pull <name|agent_id>`:
  - Name arg → reads local `MEMBER.md`, resolves `agent-id` from frontmatter (errors if unpushed).
  - GETs `/agent/<id>/export-member`, writes content to `team/<name>/MEMBER.md`.
  - Then GETs `/agent/<id>/export-journal` and writes each returned file into `team/<name>/journal/` (preserves relative paths).

## What's Done

- [x] MEMBER.md frontmatter schema (`name`, `role`, `description`, `version`, `skills`, `permissions`, `tools`, optional `agent-id`)
- [x] `atris member create <name>` scaffolds `MEMBER.md` + `skills/` + `tools/` + `context/` + `journal/`
- [x] `atris member list` shows all members with role, format, skill/context counts
- [x] `atris member activate <name>` symlinks skills into Claude/Codex/Cursor and prints context, tools, permissions
- [x] `atris member upgrade <name>` converts flat file → directory format
- [x] `atris member push <name>` creates or updates cloud agent; writes `agent-id` back to frontmatter on create
- [x] `atris member pull <name|agent_id>` downloads agent + journal; auto-resolves name via local `agent-id`
- [x] Members reference shared skills (`atris/skills/`) and local skills (`team/<name>/skills/`)
- [x] Member directories are portable (self-contained)
- [x] Spec is tool-agnostic in design

## What's Not Done

- [ ] Open source spec published separately
- [ ] `atris member link` as distinct from `activate`
- [ ] Cross-tool testing (Codex, Cursor reading MEMBER.md)

---
type: concept
slug: workspace-initialization-contract
title: Workspace Initialization Contract
sources:
  - commands/init.js
last_compiled: 2026-05-10
last_verified: 2026-05-10
confidence: 0.86
dependencies:
  - atris/wiki/systems/atris-cli.md
  - atris/wiki/concepts/agent-activation-contract.md
  - atris/wiki/concepts/wiki-as-memory-substrate.md
actionability: "Use this before changing `atris init`, workspace scaffolds, generated agent instructions, project detection, or boot hook behavior."
created: 2026-05-10
updated: 2026-05-10
tags:
  - initialization
  - workspace
  - scaffold
---
# Workspace Initialization Contract

`commands/init.js` defines the local contract for turning an arbitrary folder into an Atris-managed workspace. It is the repo-level bootstrap path, not the business workspace onboarding path.

## Shape

```text
guard workspace -> create atris/ -> scaffold memory + teams + features
                -> detect project -> inject team context
                -> generate agent entry files + hooks
                -> copy atris protocol
```

The command handles `atris init [--force]`. Help flags print usage without filesystem side effects. Normal execution refuses to run inside an existing `atris/` directory, inside a parent business workspace, or in a folder with `.atris/business.json` unless `--force` is present.

## What Init Creates

- Core workspace: `atris/`, `atris/atris.md`, `atris/PERSONA.md`, `atris/GETTING_STARTED.md`, `atris/MAP.md`, `atris/TODO.md`, `atris/now.md`, `atris/lessons.md`, and dated logs.
- Memory surfaces: wiki scaffold via `ensureWikiScaffold`, feature templates, experiments harness, and `INTUITION.md`.
- Team surfaces: `atris/team/<member>/MEMBER.md` plus `skills/`, `tools/`, and `context/` folders for default members.
- Project profile: `.project-profile.json` from package files, framework hints, directory shape, and default test command.
- Agent entry files: `AGENTS.md`, `.cursorrules`, `.cursor/rules/atris.mdc`, `.claude/commands/atris.md`, `.claude/commands/atris-autopilot.md`, `atris/CLAUDE.md`, `.claude/settings.json`, and root `CLAUDE.md` Atris markers.
- Skills: package `atris/skills/` copied into the workspace and linked into `.claude/skills/` when possible.

## Project Detection

`detectProjectContext()` scans package files first, then framework-specific dependencies, then common structure directories. It detects Node, Python, Ruby, Go, Rust, Java, PHP, Elixir, D, iOS, and markdown-only knowledge bases. The resulting test command is a default hint (`npm test`, `pytest`, `go test ./...`, etc.), not a guarantee that validation is sufficient.

`injectProjectPatterns()` writes that profile into navigator, executor, and validator specs so the first generated team has a local project shape before any agent starts work.

## Generated Agent Contract

The generated instruction files all point agents back to the same small operating loop:

- run the Atris boot sequence before first response,
- keep replies short,
- use ASCII visuals for planning,
- check `MAP.md` before code search,
- use `atris task` for ownership and proof,
- treat `TODO.md` as rendered state, not the task database.

Claude-specific setup also adds a `SessionStart` hook that runs `atris atris.md` when `atris/` exists and a `Stop` hook that points to the autopilot stop hook.

## Limits

`atris init` bootstraps local files. It does not push to cloud, create a shared business owner, or reconcile template updates after custom edits. Use business commands for shared-owner workspaces and `atris update` / sync flows for canonical file refreshes.

## Cross-References

- [[atris/wiki/concepts/agent-activation-contract.md]] - the boot behavior generated agent files point to
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] - the wiki scaffold and memory contract initialized by this command
- [[atris/wiki/systems/atris-cli.md]] - repo-level command surface that includes `atris init`

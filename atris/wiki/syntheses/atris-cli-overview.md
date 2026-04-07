---
type: synthesis
slug: atris-cli-overview
title: Atris CLI Overview
sources:
  - README.md
  - atris/MAP.md
  - package.json
last_compiled: 2026-04-07
created: 2026-04-07
updated: 2026-04-07
tags:
  - cli
  - overview
  - workspace
---
# Atris CLI Overview

`atris` is a Node.js CLI that turns a repository into an AI workspace with a strict operating loop and shared local context. The package entrypoint is `bin/atris.js`, the installed binary is `atris`, and the workspace conventions live under `atris/`.

The core working set is split across four layers. `atris/MAP.md` points to code locations, `atris/TODO.md` tracks active tasks, `atris/logs/` captures the day-to-day journal, and `atris/wiki/` stores durable knowledge that should outlive one terminal session. The CLI also supports optional cloud sync, but the repo-local workspace is the default mental model.

The most important system rule is discipline around plan, do, and review. The navigator plans, the executor builds, the validator checks, and the wiki now gives all three a local memory snapshot to build on instead of starting blind every session.

## Cross-References

- [[atris/wiki/concepts/plan-do-review-loop.md]] - the core workflow that shapes every Atris task

---
type: concept
slug: wiki-as-memory-substrate
title: Wiki as Memory Substrate
sources:
  - lib/wiki.js
  - commands/wiki.js
  - commands/loop.js
  - README.md
created: 2026-04-07
updated: 2026-06-09
last_compiled: 2026-06-09
last_verified: 2026-06-09
confidence: 0.9
dependencies:
  - atris/wiki/systems/atris-cli.md
  - atris/wiki/concepts/verifiable-reward-loop.md
actionability: "Use this before changing wiki page shape, source receipts, stale/orphan checks, wiki loop, or private memory behavior."
tags: [memory, wiki, atris]
---

# Wiki as Memory Substrate

`atris/wiki/` is the repo-local memory layer. It is not a public docs site; it is compiled memory that lets the next agent start with durable concepts, systems, people, briefs, and source receipts instead of rescanning everything.

## Current Shape

Public wiki:

```text
atris/wiki/
  wiki.md
  index.md
  log.md
  STATUS.md
  people/
  systems/
  concepts/
  briefs/
```

Private wiki:

```text
.atris/presidio/
  context/
  scorecards.md
  ...
```

Raw evidence belongs in `atris/context/` or `.atris/presidio/context/`. Compiled memory belongs in wiki pages.

## Page Contract

Agent-readable pages need frontmatter that tools can validate:

```yaml
type: person | system | concept | brief
slug: short-id
title: Human Readable
sources:
  - path/to/local/source-or-receipt
last_compiled: YYYY-MM-DD
last_verified: YYYY-MM-DD
confidence: 0.0
dependencies: []
actionability: "When to use this page."
```

`sources` should be deterministic local paths or local receipt files. External URLs should go into a local receipt file because stale checks treat `sources` as filesystem paths.

## Commands

- `atris wiki ingest <path>` stages source material under `atris/context/_ingest/`, writes a manifest, and prints an agent prompt for compilation.
- `atris wiki query "..."` reads the index first, then relevant pages.
- `atris wiki lint` asks the agent to find broken refs, orphans, contradictions, and gaps.
- `atris wiki verify` enforces the agent-readable frontmatter contract.
- `atris wiki loop` aliases the local upkeep loop.
- `atris wiki entities [--type T] [--json]` lists extracted graph entities; `atris wiki related <entity> [--json]` lists graph relationships touching an entity.
- `atris loop --dry-run --json` reports stale pages, orphan pages, and suggested ingest sources without mutating files.
- `--private` writes/reads from `.atris/presidio`; `--cloud` routes through a business workspace chat path.

## Upkeep Model

`commands/loop.js` builds a report from `lib/wiki.js`:

1. Ensure scaffold exists.
2. Read all content pages under people/systems/concepts/briefs.
3. Check stale pages by comparing `sources` mtimes to `last_compiled`.
4. Find orphan pages missing index coverage and inbound wiki links.
5. Suggest high-value source files not yet covered.
6. Write `STATUS.md` and append `log.md` unless `--dry-run`.

## What This Solves

MAP tells agents where code lives. Task state tells them what is owned. Logs tell them what happened. The wiki tells them what the system means and which old claims are still safe to use.

## Limits

- Markdown is not an embedding index.
- Source receipts are only as good as the agent that wrote them.
- Stale checks are file-time based, not semantic truth checks.
- Orphan checks are link/index based, so useful but unlinked pages can still be flagged.
- Cloud wiki paths require credentials and cannot be validated offline.

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] - system page for the CLI that hosts this wiki
- [[atris/wiki/concepts/verifiable-reward-loop.md]] - why source receipts and proof matter

---
name: wiki
description: "Local-first project wiki skill. Ingest raw sources into atris/wiki, query the wiki, lint it, and keep the memory sharp. Triggers on: wiki this, ingest this, query the wiki, lint the wiki."
version: 1.0.0
tags:
  - wiki
  - memory
  - local-first
  - knowledge
---

# /wiki

Use this when the user wants to turn source material into durable project memory.

## Canonical path

The wiki lives in `atris/wiki/`.

Use:
- `atris/wiki/wiki.md` for protocol
- `atris/wiki/index.md` for the catalog
- `atris/wiki/log.md` for append-only activity
- `atris/wiki/STATUS.md` for plain-English health

## Modes

- Local is the default. Work in the current repo and update `atris/wiki/`.
- Cloud is opt-in. Use `--cloud` only when the user wants the business workspace path.

## Ingest

When asked to ingest:
1. Read the full source before writing.
2. Ask a clarifying question if the source is ambiguous or the scope is too wide.
3. Create or update people, system, concept, and brief pages under `atris/wiki/`.
4. Update `index.md`, `log.md`, and `STATUS.md` in the same pass.
5. Merge new facts into existing pages. Do not wipe prior context.

## Query

When asked a wiki question:
1. Read `atris/wiki/index.md` first.
2. Open only the relevant pages.
3. Answer with page-path references.
4. If the answer should compound, offer to save a brief page.

## Lint

When asked to lint:
1. Check broken references, orphans, contradictions, and obvious gaps.
2. Rewrite `STATUS.md` for a non-technical reader.
3. Append a LINT entry to `log.md`.
4. Suggest the next concrete ingest sources.

## Rules

- Keep the wiki useful, not bloated.
- Say what is uncertain.
- Prefer direct language over soft summaries.
- `atris/wiki/` is the source of truth for local memory.

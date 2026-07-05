---
name: wiki
description: Use the local Atris wiki as durable project memory. Use when ingesting source material, answering questions from saved knowledge, finding stale pages, or keeping agent context sharp.
version: 1.0.0
tags:
  - wiki
  - memory
  - knowledge
  - local-first
---

# Wiki

The Atris wiki lives in `atris/wiki/`. It is the durable memory layer for facts another agent should be able to reuse.

## Bootstrap

If the repo has no Atris workspace, run:

```bash
npx -y atris init
```

Then read:

- `atris/wiki/index.md` for the catalog.
- `atris/wiki/STATUS.md` when present for current health.
- `atris/wiki/wiki.md` when present for local wiki rules.

## Ingest

Use ingest when the user asks to save source material, preserve context, or make knowledge durable.

```bash
atris wiki ingest <path-or-url>
```

Discipline:

1. Read the full source before writing conclusions.
2. Create or update focused pages under `atris/wiki/`.
3. Keep source, last verified date, dependencies, confidence, and actionability visible.
4. Update `index.md`, `log.md`, and `STATUS.md` in the same pass when the CLI does not do it for you.
5. Merge with existing pages instead of overwriting useful memory.

## Query

Use query when the user asks what the repo already knows.

```bash
atris wiki query "<question>"
```

Manual fallback:

1. Read `atris/wiki/index.md`.
2. Open only the relevant pages.
3. Answer with page-path references.
4. State uncertainty when the wiki lacks proof.

## Lint

Use lint or upkeep when the wiki may be stale:

```bash
atris wiki lint
```

Check for broken links, orphan pages, stale sources, contradictions, and missing next ingests. Keep the result concrete: what is stale, what changed, and what source should be ingested next.

## Rules

- Local wiki first. Cloud sync is opt-in and only when the user asks.
- Do not bury project truth in chat.
- Keep pages short enough to be reused.
- Prefer direct source-backed facts over broad summaries.


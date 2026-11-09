---
name: wiki
description: "Local-first project memory. Ingest sources into atris/wiki, answer questions from it and keep it as small linked notes an agent can find fast. Triggers on: wiki this, ingest this, query the wiki, lint the wiki, reorganize memory, notes are too big."
version: 1.1.0
tags:
  - wiki
  - memory
  - local-first
  - knowledge
---

# /wiki

Use this when the user wants to turn source material into durable project memory.

Project memory is small linked notes. An index fits on one screen and each line says when to open the note behind it. Agents read the index and open only the notes their work touches.

## The list

- An index line gives the rule itself and says when to open more. A bare topic name makes the reader open the file just to see if it matters. Open [index-lines.md](index-lines.md) when you write or review an index.
- One idea per note, under about 80 lines, with real examples right under the rule they prove. Open [note-shape.md](note-shape.md) when you create a note or one has grown.
- Two layers at most from boot. The boot files point to an area index and the index points to notes. Open [index-lines.md](index-lines.md) before adding a third layer.
- Merge duplicates, move text instead of rewriting it and prune only what you can prove is stale. Open [upkeep.md](upkeep.md) when you consolidate, split or delete.
- Measure recall with questions the improver never saw. Open [measure.md](measure.md) before you claim memory got better.

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
   Also flag index lines that are bare topic names and pages over about 80 lines.
2. Rewrite `STATUS.md` for a non-technical reader.
3. Append a LINT entry to `log.md`.
4. Suggest the next concrete ingest sources.

## Rules

- Keep the wiki useful, not bloated.
- Keep this page to one screen. Detail goes in the notes.
- Say what is uncertain.
- Prefer direct language over soft summaries.
- `atris/wiki/` is the source of truth for local memory.

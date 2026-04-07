---
name: loop
description: "Wiki upkeep loop. Scans atris/wiki for stale pages, orphan pages, and high-value next ingests, then refreshes STATUS.md and log.md. Triggers on: /loop, upkeep the wiki, run the wiki loop."
version: 1.0.0
tags:
  - loop
  - wiki
  - upkeep
  - memory
---

# /loop

Use this when the user wants the wiki kept alive instead of just written once.

## What it does

1. Run `atris loop`.
2. Read the summary from `atris/wiki/STATUS.md`.
3. Surface stale pages, orphan pages, and the next ingest candidates.
4. If the user wants action, move immediately into `atris ingest` or a manual wiki page refresh.

## Local-first

- Default to the local repo wiki.
- Do not auto-push.
- Do not pretend cloud upkeep exists if only the local loop is implemented.

## Good usage

- "run /loop"
- "upkeep the wiki"
- "what should we ingest next?"
- "is the wiki stale?"

## Rules

- Keep the loop deterministic.
- Prefer concrete next moves over abstract health language.
- If the wiki is stale, say which page is stale and why.

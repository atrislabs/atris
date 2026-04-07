# Wiki Upkeep Loop

> **Status:** shipped
> **Created:** 2026-04-07
> **Last Updated:** 2026-04-07

---

## Problem Statement

`atris/wiki/` existed, but after ingest there was no small, repeatable command that checked whether the memory had drifted. The wiki could become stale, pages could sit unlinked, and the next source to ingest stayed implicit instead of visible.

---

## Solution Design

Add a deterministic local upkeep command: `atris loop`. It analyzes `atris/wiki/`, refreshes `STATUS.md`, appends a `LOOP` entry to `log.md`, flags stale and orphan pages, and suggests a short next-ingest queue from important repo files not yet represented in wiki page frontmatter. `atris wiki loop` becomes a namespace alias, while cloud sync stays manual.

This slice is intentionally not cron, autopilot, or auto-ingest. It makes upkeep real first, then background scheduling can call the same command later.

---

## ASCII Visualization

```text
atris loop
    |
    v
read atris/wiki/*
    |
    +--> stale pages?
    +--> orphan pages?
    +--> next sources?
    |
    v
rewrite STATUS.md
append LOOP to log.md
print next move
```

---

## Success Criteria

- [x] `atris loop` runs locally against `atris/wiki/`
- [x] `atris wiki loop` routes to the same upkeep logic
- [x] `STATUS.md` refreshes `Last loop`, `Health`, and `Next move`
- [x] `log.md` gets an append-only `LOOP` entry
- [x] stale pages are detected from `sources` + `last_compiled`
- [x] orphan pages are detected from missing index and inbound links
- [x] next-ingest suggestions come from high-value repo files not already covered
- [x] one smoke test proves upkeep updates wiki state, not just console output

---

## User Impact

The wiki stops being write-only memory. You can run one command and immediately see whether the repo brain is stale, disconnected, or ready for the next ingest.

---

## Technical Notes

- Local-first only. `--cloud` stays unimplemented for loop on purpose.
- The command supports `--dry-run`, `--json`, and `--limit=N`.
- Auto-push is still the wrong layer; `atris push --only wiki` remains manual.

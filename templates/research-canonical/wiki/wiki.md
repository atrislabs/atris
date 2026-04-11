# Atris Wiki Protocol

This wiki lives in `atris/wiki/`.

## Purpose

Turn raw project context into a living memory the next agent can pick up cold.

## Shape

- `atris/wiki/wiki.md` - this protocol
- `atris/wiki/index.md` - catalog grouped by page type
- `atris/wiki/log.md` - append-only ingest and lint history
- `atris/wiki/STATUS.md` - plain-English health summary
- `atris/wiki/people/` - humans (employees, contacts, stakeholders)
- `atris/wiki/systems/` - tools, tables, dashboards, services, products
- `atris/wiki/concepts/` - patterns, frameworks, recurring ideas
- `atris/wiki/briefs/` - multi-page briefs and cross-cutting analysis

## Rules

- Read the full source before writing.
- Merge new facts into existing pages. Do not overwrite history blindly.
- Add cross-references with `[[atris/wiki/...]]` links.
- Keep `index.md`, `log.md`, and `STATUS.md` in sync with page changes.
- If something is unclear or contradictory, say so directly.

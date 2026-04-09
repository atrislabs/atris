# Context — {{name}}

Raw source material for {{name}}.
`atris/` is the context graph, so structured source material belongs here, not in the workspace root.

## How to use

- Drop new sources here as files (`.md`, `.sql`, `.json`, etc.)
- Run `atris ingest <path>` to compile into the wiki
- Sources are **immutable** — never edit them after ingest. If a source changes, create a new dated copy.
- Files outside `atris/` should stay as boot shims, exports, or random scratch output only

## Suggested layout

- `company-overview.md` — mission, team, stage
- `people/` — one file per key stakeholder
- `sql/` — database queries (if applicable)
- `briefs/` — meeting notes, deal briefs
- Anything else relevant

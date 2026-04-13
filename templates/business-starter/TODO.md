# {{name}} — Active Tasks

> Working task queue. Target state = 0.
> Daily tasks live in `atris/logs/YYYY/YYYY-MM-DD.md`.

## Endgame

**Slug:** first-business-loop
**Picked:** {{today}}
**Horizon:** Turn the starter into one real business loop with a measurable concept page, one named human, and one recap that writes structured state.
**Source:** workspace bootstrap

## Backlog

- **B1:** Create the first measurable loop page in `atris/wiki/concepts/` using `first-loop-template.md` [endgame]
  **Verify:** test -n "$(find atris/wiki/concepts -maxdepth 1 -type f -name '*.md' ! -name 'first-loop-template.md' -print -quit)"
- **B2:** Add the first named human to both `atris/team/` and `atris/wiki/people/` [endgame]
  **Verify:** test -n "$(find atris/team -mindepth 1 -maxdepth 1 -type d ! -name '_template' ! -name 'ops' ! -name 'comms' ! -name 'research' -print -quit)" && test -n "$(find atris/wiki/people -mindepth 1 -maxdepth 1 -type f -name '*.md' -print -quit)"
- **B3:** Write the first dated recap, then run `atris business record <report-path>` to append structured state entries [endgame]
  **Verify:** test -n "$(find atris/reports -maxdepth 1 -type f -name '*.md' ! -name 'README.md' ! -name 'operating-recap-template.md' -print -quit)" && test -s .atris/state/events.jsonl && test -s .atris/state/episodes.jsonl && test -s .atris/state/scorecards.jsonl

## In Progress

(none)

## Completed

(clear)

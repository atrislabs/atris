# {{name}} — Active Tasks

> Working task queue. Target state = 0.
> Daily tasks live in `atris/logs/YYYY/YYYY-MM-DD.md`.

## Endgame

**Slug:** first-research-loop
**Picked:** {{today}}
**Horizon:** Turn the starter into one real lab loop with a filled research program, one concrete experiment artifact, and one structured run summary.
**Source:** workspace bootstrap

## Backlog

- **R1:** Fill `atris/wiki/briefs/research-program.md` with the first real mission, bet, eval, and constraints [endgame]
  **Verify:** ! rg -q "what domain are we trying to move\\?|what is the first hypothesis worth testing\\?|what metric decides whether we improved\\?|what data, time, or reproducibility limits matter\\?" atris/wiki/briefs/research-program.md
- **R2:** Add the first concrete experiment or eval artifact under `atris/reports/` [endgame]
  **Verify:** test -n "$(find atris/reports -maxdepth 1 -type f -name '*.md' ! -name 'README.md' -print -quit)"
- **R3:** Append the first structured run summary and one lesson from the experiment [endgame]
  **Verify:** test -s .atris/state/events.jsonl && test -s .atris/state/episodes.jsonl && test -s .atris/state/scorecards.jsonl && ! rg -q "no lessons yet" atris/policies/LESSONS.md

## In Progress

(none)

## Completed

(clear)

---
type: concept
slug: horizon-types
title: Horizon Type Categorization
sources:
  - commands/autopilot.js
  - lib/scorecard.js
  - atris/MAP.md
created: 2026-04-09
updated: 2026-06-30
last_compiled: 2026-07-12
last_verified: 2026-06-30
confidence: 0.86
dependencies:
  - atris/wiki/concepts/verifiable-reward-loop.md
  - atris/wiki/concepts/plan-do-review-loop.md
actionability: "Use when naming endgame horizons or debugging why autopilot prefers one horizon candidate over another."
tags: [horizon, endgame, type-system, autopilot]
---

# Horizon Type Categorization

A horizon is the target state an endgame pursues. Atris still relies on a simple naming convention: the first segment of an endgame slug is treated as its historical type.

```text
loop-self-seeds-horizons -> loop
wiki-for-atrisos-web     -> wiki
verify-map-refs          -> verify
```

## Current Scoring Path

Before scoring, autopilot can propose horizons from live signals:

- recent commits from `git log --oneline -20`
- `atris/wiki/STATUS.md`
- recent lines from `atris/lessons.md`
- unresolved `fail` lessons whose detector or file grep still confirms the bug pattern

Pass lessons and already resolved lessons are not open work. Candidate horizons that match shipped or resolved lessons are filtered; when a lesson is proven resolved, the proposer can tag that lesson `[resolved]` in `atris/lessons.md`.

`scoreEndgameCandidates()` in `commands/autopilot.js`:

1. Reads the last 10 private scorecards from `.atris/presidio/scorecards.md` through `readScorecards()`.
2. Infers historical type from each scorecard slug with `sc.slug.split('-')[0]`.
3. Computes mean reward and success rate per type.
4. Infers each candidate's type from title keywords that match known type prefixes, otherwise from the first word/segment of the title.
5. Scores expected value as `historicalMean * candidate.confidence`.
6. Filters easy-win types when they have success rate over 80% and mean reward over 5 while harder candidates exist.
7. Uses an adaptive exploit/explore split, with explore rate between 20% and 50% based on recent type diversity.

If there is no `atris/` folder or no scorecards, the scorer falls back to highest candidate confidence.

## Known Type Prefixes

| Prefix | Meaning | Typical scope |
|--------|---------|---------------|
| `loop` | Autopilot heartbeat, recurrence, self-seeding | `commands/autopilot.js`, `commands/run.js` |
| `wiki` | Project memory, ingest, query, lint, upkeep | `lib/wiki.js`, `commands/wiki.js`, `commands/loop.js` |
| `verify` | Deterministic completion checks | `commands/verify.js`, validators, tests |
| `refactor` | Internal cleanup without behavior change | code organization |
| `human` | Operator-facing output and decisions | command text, status surfaces |
| `agent` | Multi-agent coordination and collision control | task claims, leases, Swarlo handoff |
| `mission` | Mission runtime, verifiers, receipts | `commands/mission.js`, member `now.md` |
| `task` | Durable task plane and projection | `commands/task.js`, `lib/task-db.js` |

New prefixes are allowed, but they should be intentional. If a title can use an existing prefix, use it; otherwise the first word becomes the type and historical reward will be sparse.

## Scorecard Contract

Closed endgames write one private scorecard line under `.atris/presidio/scorecards.md`:

```markdown
- **[YYYY-MM-DD] slug** — shipped: X/Y — wall-clock: Nh — halt: Z% — reward: R — lessons: N
```

The parser in `lib/scorecard.js` accepts the current rendered format and returns:

- `slug`
- `tasksShipped`
- `tasksAttempted`
- `wallClockHours`
- `haltRatio`
- `totalReward`
- `lessonsGenerated`

The slug is the source of truth for historical type. Candidate titles are only matched against prior type prefixes.

## Naming Rules

- Put the type first: `wiki-refresh-contract`, not `refresh-wiki-contract`.
- Keep the prefix one segment: `verify-*`, not `verify-map-*` as a multi-part type.
- Prefer verbs after the prefix: `mission-wire-status-filters`, `task-projection-cap`.
- Use lowercase kebab case.
- Do not create a new type to make a task sound important.

## Residual Risk

The system is heuristic. If scorecards are empty, stale, or dominated by one type, candidate selection can be noisy. The adaptive explore rate reduces lock-in, but it does not replace a human naming horizons clearly.

2026-07-12 source check: recent autopilot changes left the slug-prefix type inference, last-10 scorecard window, difficulty floor, and adaptive exploration path unchanged.

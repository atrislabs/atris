---
type: concept
slug: verifiable-reward-loop
title: Verifiable Reward Loop
sources:
  - README.md
  - atris/TODO.md
  - commands/autopilot.js
  - lib/scorecard.js
  - atris/scorecards.md
created: 2026-04-09
updated: 2026-04-09
last_compiled: 2026-04-09
tags:
  - reward
  - autopilot
  - endgame
  - verification
  - rl
---

# Verifiable Reward Loop

Atris does not retrain the model. It creates a repo-local environment where agent actions hit deterministic checks, those checks emit reward, and future horizon picks can condition on outcome history. In that sense, it now behaves like an RL-style environment around a fixed model, not an RL-trained model itself.

## Environment pieces

- **Action surface** — `plan`, `do`, `review`, and `autopilot` act on real repo state.
- **Truth substrate** — endgame tasks can carry `Verify:` commands that exit cleanly or fail mechanically.
- **Reward substrate** — autopilot tick summaries write reward into the journal from observable signals.
- **Episode memory** — closed horizons append scorecards to `atris/scorecards.md`.
- **Policy update** — future horizon picks can weight candidates against recent scorecard history.

## Loop shape

1. `/endgame` writes a horizon and backlog tasks with deterministic `Verify:` checks.
2. `autopilot` executes one task and runs the verify command after review passes.
3. The tick summary records reward in today's journal.
4. When the horizon closes, a scorecard is appended with shipped work, reward, halt ratio, and lessons.
5. The next horizon picker can read those scorecards and weight similar work higher or lower.

## Why "environment creator" is the right phrase

- The model stays fixed; there is no weight update or fine-tune loop here.
- The repository, the task board, the verify checks, and the journal create the environment the model acts inside.
- Rewards come from mechanical checks, not from the model grading itself.
- Improvement comes from stronger checks and better horizon selection, not from changing the underlying model.

## Honest limits

- Reward shaping is still hand-authored and local to this repo.
- Scorecard history is small, so weighting is useful but not magical.
- Verify coverage is only as strong as the checks the human or agent writes.
- The loop can learn which work shapes close cleanly, but it is not doing policy-gradient training or hidden self-modification.

## Cross-References

- [[atris/wiki/briefs/atris-cli-overview.md]] — the repo-level summary where this rail is placed in the full stack
- [[atris/wiki/concepts/plan-do-review-loop.md]] — the base execution loop this reward rail sits on top of
- [[atris/wiki/concepts/horizon-types.md]] — the type system used when scorecards weight future horizon candidates

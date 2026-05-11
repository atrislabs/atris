---
type: concept
slug: verifiable-reward-loop
title: Verifiable Feedback Loop
sources:
  - README.md
  - atris.md
  - atris/TODO.md
  - commands/autopilot.js
  - lib/scorecard.js
  - commands/task.js
  - lib/task-db.js
created: 2026-04-09
updated: 2026-05-10
last_compiled: 2026-05-10
last_verified: 2026-05-10
confidence: 0.84
dependencies:
  - atris/wiki/concepts/plan-do-review-loop.md
  - atris/wiki/briefs/atris-cli-overview.md
actionability: "Use this when deciding whether a task, mission, or experiment has enough proof to count as useful work."
tags:
  - reward
  - autopilot
  - endgame
  - verification
  - rl
---

# Verifiable Feedback Loop

Atris can close work on deterministic checks, record reward from those checks, and keep local scorecards or review episodes for future routing. That makes the loop more grounded in repo history without claiming model retraining.

## Environment pieces

- **Action surface** — `plan`, `do`, `review`, and `autopilot` act on real repo state.
- **Truth substrate** — tasks and feature rubrics can carry `Verify:` commands that exit cleanly or fail mechanically.
- **Confidence substrate** — plan, do, and review run the Confidence Gate so loopholes are patched or named before advancing.
- **Task reward substrate** — `atris task review` and `finish` can record proof, reward, lessons, lineage, and next tasks in local state.
- **Autopilot reward substrate** — autopilot tick summaries can write reward into the journal from observable signals.
- **Scorecard memory** — closed endgame horizons can append `.atris/presidio/scorecards.md` when that rail is active.
- **Policy update** — future horizon picks can weight candidates against recent scorecard history when enough history exists.

## Loop shape

1. Work enters `atris task` with an owner, context, exit condition, and proof target.
2. The agent executes plan -> do -> review and runs the declared verification.
3. The task is finished only with proof; review can add reward, lesson, and next task linkage.
4. Autopilot/endgame runs add a second rail: tick reward, verify pass/fail, commit registry, and optional closed-horizon scorecards.
5. Future routing can use recent task/reward history and scorecards, but the system stays local-first.

## Privacy boundary

- `atris/wiki/` is the publishable knowledge surface.
- `.atris/state/` is the local operating surface for task episodes, mission events, member loop state, and compiled projections.
- `.atris/presidio/` is the local-only operating surface for endgame scorecards and sensitive tuning notes when that rail writes them.
- Distilled lessons can graduate into the public wiki; raw reward shaping should stay in local state or Presidio.

## Honest limits

- Reward shaping is still hand-authored and local to this repo.
- Scorecard and episode history is small, so weighting is useful but not magical.
- Verify coverage is only as strong as the checks the human or agent writes.
- The loop can learn which work shapes close cleanly, but it is not doing model retraining.

## Cross-References

- [[atris/wiki/briefs/atris-cli-overview.md]] — the repo-level summary where this rail is placed in the full stack
- [[atris/wiki/concepts/plan-do-review-loop.md]] — the base execution loop this reward rail sits on top of
- [[atris/wiki/concepts/horizon-types.md]] — the type system used when scorecards weight future horizon candidates

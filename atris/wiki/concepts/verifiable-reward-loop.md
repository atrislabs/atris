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
  - commands/lesson.js
  - lib/policy-lessons.js
  - lib/task-db.js
created: 2026-04-09
updated: 2026-06-30
last_compiled: 2026-07-12
last_verified: 2026-06-30
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
- **Task reward substrate** — `atris task ready --proof` puts agent work in Review (cited receipts must exist and pass on disk), `atris task review` records reward/lessons/lineage, and `review-lane-run` drains the queue to certified agent-side.
- **Mission substrate** - missions carry an owner, runner, verifier, stop condition, and tick receipts. `atris run` pursues one bounded mission; `atris autopilot` keeps selecting mission or member legs until stopped.
- **Policy lesson substrate** — `atris lesson mine` turns accepted receipts, review episodes, and scorecards into policy lessons that coach the next `ready` submission (evidence-backed hints, not vibes).
- **AgentXP substrate** — `atris play`, `atris gm`, and `atris xp` run the proof-backed game loop; no proof means no AgentXP, and only human `atris task accept` mints Career XP for the local card or hosted leaderboard.
- **Autopilot reward substrate** — autopilot tick summaries can write reward into the journal from observable signals.
- **Pulse substrate** — `atris pulse` is the durable overnight heartbeat; it runs due mission work on a clock, but still depends on verifier receipts and task review before work counts.
- **Scorecard memory** — closed endgame horizons can append `.atris/presidio/scorecards.md` when that rail is active.
- **Policy update** — future horizon picks can weight candidates against recent scorecard history when enough history exists.

## Loop shape

1. Work enters `atris task` with an owner, context, exit condition, and proof target, or enters a mission with an owner, runner, verifier, and stop condition.
2. The agent executes plan -> do -> review inside the bounded work leg and runs the declared verification.
3. The agent moves work to Review with `atris task ready --proof`; the lane checks cited receipts against disk and policy hints coach evidence-less proofs. Agent review passes certify the work, but only human `atris task accept` closes the task and mints Career XP. Review can add reward, lesson, and next task linkage.
4. Autopilot/endgame runs add a second rail: tick reward, verify pass/fail, commit registry, and optional closed-horizon scorecards.
5. Accepted receipts feed back into the loop: `atris lesson mine` distills them into policy lessons that change live submission behavior, so the gate teaches the agents it gates.
6. Future routing can use recent task/reward history and scorecards, but the system stays local-first.

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

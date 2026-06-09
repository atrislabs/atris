---
title: Recursive self-improvement — capability position
type: concept
status: living
last_reviewed: 2026-06-08
sources:
  - commands/improve.js (the loop's CLI bridge + scorecard/history machinery)
  - atris/experiments/policy-optimize/ (keep/revert on a real model's policy)
  - atris/experiments/weight-optimize/ (keep/revert on real network weights)
  - atris/lessons.md (improve-cli-bridge, improve-loop-operated-recursively)
related:
  - "[[verifiable-reward-loop]]"
  - "[[wiki-as-memory-substrate]]"
---

# Recursive self-improvement — capability position

The honest answer to "is the self-improvement loop progress toward more capable
AI?" — stated so the next agent neither overclaims nor underclaims.

## What is real and shipped

`atris improve` (commands/improve.js, 24 tests) is the loop's working bridge: a
credit-metered tick against `/api/improve`, a per-tick scorecard substrate
(`.atris/state/scorecards.jsonl`), `improve history` to read the trend, journal +
member attribution, and a local fallback. The loop was then operated on **its own
machinery** for 5 verified ticks — each shipped a real feature with tests, two of
the bugs found by running it live. That is real capability the system did not have
before. It is **leverage-axis**: it makes a fixed-intelligence agent more effective
and reliable; it does not change model weights.

## The mechanism, demonstrated at three levels

The core of any capability gain is keep/revert: measure, propose, keep only if a
held-out score rises, revert otherwise. Two reproducible experiments show it past
a binary verifier:

- **policy / real model** (`experiments/policy-optimize/`): optimize the policy
  driving a real model, scored by its accuracy on a held-out eval. Run: 0.50 →
  0.75. This is *elicitation* — more of the model's existing capability, weights
  unchanged.
- **weights / real backprop** (`experiments/weight-optimize/`): the network
  **weights** are the subject; candidates trained from scratch, kept only if they
  beat the incumbent on a held-out set. Run: 0.56 → 0.98, gate reverted a diverging
  and a non-improving config. This is the intelligence axis — at tiny scale.

## The honest boundary

None of this is AGI/ASI, and the wiki must not say it is. The improve command and
the policy experiment are leverage. The weight experiment is genuine
intelligence-axis optimization but on a 2D-toy-task MLP. The distance from that
mechanism to real capability is **scale** — model size, data, task generality,
compute — which is a resource question, not a mechanism, axis, or
missing-infrastructure question. The control loop is proven; frontier scale is the
input a laptop cannot supply.

## Next move

Point the same keep/revert loop at real training compute and a real model:
fine-tune candidates scored on a held-out eval, kept only if they beat the
incumbent. The experiments here are the rehearsal of exactly that loop. Until the
compute exists, this is the accurate position — a verified self-improvement loop on
the leverage axis, a small-scale intelligence-axis experiment, and an honest gap
named scale.

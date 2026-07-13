---
title: Recursive self-improvement — capability position
type: concept
status: living
updated: 2026-06-30
last_reviewed: 2026-06-30
last_compiled: 2026-07-12
last_verified: 2026-06-30
sources:
  - commands/improve.js
  - atris/experiments/policy-optimize/README.md
  - atris/experiments/weight-optimize/README.md
  - atris/lessons.md
confidence: 0.82
dependencies:
  - atris/wiki/concepts/verifiable-reward-loop.md
  - atris/wiki/concepts/wiki-as-memory-substrate.md
  - atris/wiki/systems/atris-cli.md
actionability: "Use this when explaining what Atris self-improvement can honestly claim: verified leverage loops, small-scale weight experiments, and a scale gap, not AGI/ASI."
related:
  - "[[verifiable-reward-loop]]"
  - "[[wiki-as-memory-substrate]]"
---

# Recursive self-improvement — capability position

The honest answer to "is the self-improvement loop progress toward more capable
AI?" — stated so the next agent neither overclaims nor underclaims.

> Source note: `commands/improve.js` is the loop's CLI bridge plus the
> vitals, doctor, scorecard, and history machinery. `atris/experiments/policy-optimize/` covers
> keep/revert on a real model's policy; `atris/experiments/weight-optimize/`
> covers keep/revert on real network weights. Lesson IDs: improve-cli-bridge,
> improve-loop-operated-recursively.

## What is real and shipped

Bare `atris improve` now shows the loop's metabolism: scheduled heartbeat and
reward, daily experiment state, scout findings, open and overdue loops, and
weekly command use. It also refreshes a live HTML view. `atris improve tick` is
the shipping bridge: it runs a credit-metered `/api/improve` tick or exactly one
verified local mission tick when the hosted path cannot reach the workspace,
then writes the scorecard and journal receipt. The loop was operated on **its own
machinery** for 5 verified ticks, each shipping a real feature, with two bugs
found by running it live. That is real leverage-axis capability: a
fixed-intelligence agent becomes more effective and reliable without changing
model weights.

`atris improve doctor` scans recent loop receipts for failures in the loop
itself. `--fix` files at most one deduplicated repair mission, while `--check
<kind>` is a write-free verifier. Filing earns zero reward; a later observation
credits the repair only after that finding is provably absent.

The lesson-mining rail extends this: `atris lesson mine` distilled 147 accepted
receipts, 326 review episodes, and 12 scorecards into policy lessons that coach
agents at `ready` time, with a live before/after receipt showing the hints changed
a real submission with zero human turns
(`atris/dogfood/policy-lessons-before-after-2026-06-10.json`). Same axis — the
system now teaches its agents from its own accepted history.

2026-06-30 source refresh from `atris/lessons.md`: newer lessons narrow the
claim rather than expand it. `pulse-closes-open-loop` says the loop needs durable
ignition, not just an engine. `self-report-honesty-bugs` says self-reports and
reward need adversarial detectors. `string-metric-is-pre-filter-not-verifier`
says string metrics cannot certify prompt quality. `gate-saturation-regime` says
more verified work is not improvement when the human accept gate is saturated.
So the current position stays bounded: verified loops create leverage only when
receipts, detectors, and human gates stay honest.

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

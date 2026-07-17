# Taste loop

## Outcome

Reject generic writing, websites, and video prompts with one shared taste gate.
Frozen positive and rejected references teach it what to keep.

## Target

`candidate.json` is the only mutable target. `fixtures.json` is the independent
judge contract and proposals must never change it.

## Metric

Each modality receives four scores:

- generic structure, where lower is better
- product specificity, where higher is better
- reference adherence, where higher is better
- repeated slop, where lower is better

Quality is the geometric mean of specificity, reference adherence, generic
cleanliness, and slop cleanliness. One strong axis cannot hide another failure.

## Keep rule

A proposal stays only when its aggregate and every modality improve by `0.05`.
Writing-only wins revert.

## Proof

`results.tsv` records every baseline, proposal, modality score, and decision.
`scorecard.latest.json` stores the latest measurement. Skill overlays require
explicit operator approval.

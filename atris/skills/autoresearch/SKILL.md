---
name: autoresearch
description: Karpathy-style keep/revert experiment loop for Atris experiment packs. Use when improving prompts, tools, workers, or bounded repo targets.
version: 1.0.0
tags:
  - experiments
  - keep-revert
  - optimization
  - metrics
---

# Autoresearch Skill

Autoresearch means one bounded target, one external metric, one keep/revert loop, one append-only log.

## When to use

- prompt optimization
- worker routing
- tool behavior
- evaluation harnesses
- any repo-local target that can be measured honestly

## Process

1. Read `atris/experiments/<slug>/program.md`
2. Confirm the target is bounded
3. Run the baseline with `measure.py`
4. Apply one candidate change
5. Rerun the metric
6. Keep only if the score improves
7. Write the outcome to `results.tsv`
8. Revert losses

## Rules

- external metric only
- no unlogged keeps
- no broad refactors inside an experiment
- one experiment pack = one target
- if variance exists, define the keep margin first

## Commands

```bash
atris experiments init <slug>
atris experiments validate
atris experiments benchmark
```

## Good output

- short `program.md`
- honest `measure.py`
- deterministic `loop.py`
- append-only `results.tsv`

## Bad output

- "felt better"
- changed three things at once
- kept a patch without a measured win
- no reset/revert path

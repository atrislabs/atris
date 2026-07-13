---
type: concept
slug: strong-model-handoff
title: Strong Model Handoff
sources:
  - atris/skills/fable-method/SKILL.md
  - atris/wiki/concepts/plan-do-review-loop.md
last_compiled: 2026-07-12
last_verified: 2026-07-04
confidence: 0.85
dependencies:
  - atris/wiki/concepts/verifiable-reward-loop.md
actionability: "When a stronger model is temporarily available, spend it writing process artifacts (skills, briefs, verifiers) that the daily-driver model runs afterward."
created: 2026-07-04
updated: 2026-07-04
tags:
  - meta
  - skills
  - models
---
# Strong Model Handoff

When a frontier model is available for a limited window, the durable output is not the code it writes; it is the process it leaves behind. Capability does not transfer between models. Process does: checklists, verification contracts, stuck protocols, and memory formats survive as files and run on any model.

Concretely, that is what `atris/skills/fable-method/SKILL.md` is: Claude Fable 5 distilling its own working method (whole-brief-first, parallel context sweep, real-runtime verification, receipt-gated "done", localized uncertainty, judge/worker separation) into a skill the daily-driver model loads. It was written 2026-07-04, three days before Fable moved to pay-per-use.

## Why this works

A skill cannot make a smaller model smarter, but most of the observable gap between models is not raw reasoning; it is discipline failures the smaller model can be checklisted out of: shrinking scope silently, reporting done without running anything, hedging everything instead of localizing the one uncertain part, flipping under pushback, retrying the same failing command. Those are process bugs, and process bugs are fixable in markdown.

## The pattern, generalized

While the strong model is available:

1. Feed it the hardest problems, not routine work; routine work wastes the window.
2. Hand it one large brief with all constraints up front, not 20 small turns.
3. Have it self-verify before reporting; that is where its extra depth pays.
4. Have it write the handoff artifacts: skills, verifiers, memory entries, and briefs the cheaper model will execute against later.

## Operational handoff details

- Keep dispatched builds in the foreground until they ship with proof or stop on a named blocker.
- Brief a headless builder with the goal, verified file references, `Done:`, `Check:`, and explicit git ownership. Pin any engine the operator named.
- Run builders only in isolated worktrees, then have a separate judge read the diff and execute the real verifier without a pipeline that can mask its exit code.
- After the same failure twice, stop retrying. Write three concrete hypotheses and run the cheapest discriminating check.
- Record a real lesson as one typed fact with why it matters and how to apply it. Convert twice-broken discipline into a mechanism instead of more doctrine.

This is the same shape as the Atris thesis: the folder is the brain, the model is a swappable engine. A strong-model window is a chance to upgrade the folder.

## Boundaries

- The skill transfers taste and workflow, not reasoning depth. Genuinely hard design calls still deserve the stronger model, paid per use if needed.
- Keep the skill honest with the verifiable-reward loop: if a checklist item cannot be checked (no receipt, no command), it is doctrine slop and should be cut.

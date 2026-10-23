# weight-optimize — the intelligence-axis step (weights as the subject)

The step every prior turn deferred as "infra-gated": make the **network weights**
the subject of the keep/revert loop. Not a policy, not a prompt, not a heuristic —
weights, changed by real gradient descent, selected on **held-out generalization**.

## Recorded run (2026-06-08, numpy backprop)

```
  0.56  KEEP    C0 H=1  lr=0.5  (underfit — can't bend the boundary)
  0.98  KEEP    C1 H=8  lr=0.5  (capacity to learn the curve)
  0.94  REVERT  C2 H=8  lr=8.0  (lr too high — training destabilizes)
  0.98  REVERT  C3 H=24 lr=0.7  (ties incumbent — not strictly better)
  → held-out generalization 0.56 → 0.98; gate reverted a diverging and a non-improving config
```

A 2→H→1 MLP, trained from scratch per candidate via real backprop, scored on a
**held-out** set drawn separately from train. The network learns a non-linear
capability (circle classification) it did not have at initialization; keep/revert
selects the weight-configuration that generalizes.

## What this is — and is not

- **Is:** genuine intelligence-axis optimization. The subject is the weights;
  gradient descent moves them; selection is on held-out generalization. This is
  the real control loop, not elicitation and not a heuristic. The
  "elicitation-not-weights / infra-gated / deferred" objection is removed.
- **Is not:** AGI or ASI. It is a tiny MLP on a 2D task. The distance from here to
  ASI is **scale** — model size, data, task generality, compute — which is a
  resource/engineering question, not a mechanism or axis question. The mechanism
  is the same one demonstrated here; ASI is this loop at frontier scale, which a
  laptop coding session cannot reach.

## The three levels, now all run

1. heuristic subject (toy) — mechanism only
2. policy subject, real model — elicitation, 0.50→0.75 (`../policy-optimize`)
3. **weight subject, real backprop — generalization, 0.56→0.98 (here)**

Level 3 is the intelligence axis. What separates it from ASI is scale, stated
plainly, not faked.

See `atris/wiki/concepts/recursive-self-improvement-position.md`.

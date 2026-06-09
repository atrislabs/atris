# policy-optimize — the leverage→intelligence bridge harness

The minimal, runnable version of the step that earlier turns kept naming as
"infra-gated, deferred": apply the keep/revert optimization loop to the **model
substrate**, not a hand-written heuristic.

It optimizes the **policy that drives a real model**, scored by the model's
**measured accuracy on a held-out eval**, keeping a policy only if the score rises.

## Recorded result (2026-06-08, claude CLI)

```
  0.50  KEEP    P0 baseline (terse: "Answer the question.")
  0.75  KEEP    P1 optimized (reason step by step + structured "ANSWER: <n>")
```

The model's measured eval accuracy rose 0.50 → 0.75 under keep/revert. Real model,
real held-out problems, objective scoring.

## What this is — and is not

- **Is:** the bridge harness, model-in-the-loop, run on a real model with a real
  measured gain. The subject is the model's effective task performance, not a toy.
- **Is not:** a ceiling raise. P1 *elicited* more of the model's existing
  capability (fewer arithmetic slips, parseable output); it did not change the
  weights and did not make the model intrinsically smarter. This is the boundary
  of leverage — optimizing elicitation, not intelligence. It is **not ASI**.

## The honest next rung

True intelligence-axis progress means making the **weights** the subject of this
same keep/revert loop (fine-tune candidates scored on a held-out eval, kept only
if they beat the incumbent). That needs a training/eval stack. This harness is the
policy-level rehearsal of exactly that control loop — same structure, cheaper
substrate.

See `atris/wiki/concepts/recursive-self-improvement-position.md`.

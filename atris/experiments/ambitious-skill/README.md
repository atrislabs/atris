# ambitious skill, does it earn its place?

Question: does the four-question rewrite in `atris/skills/ambitious/SKILL.md`
make the finished work better, or does it only make it longer?

## Arms

- **plain**: the task as the person typed it.
- **nudge**: the task plus one generic line asking for the deeper, top-professional version. This is the control that matters. If the skill only beats plain, the win could be "asked for more, got more".
- **skill**: a separate call answers the four questions and rewrites the task; a fresh call does only the rewritten task.

Same worker model for all three, no tools, no settings, empty folder.

## Judge

A different model (codex) sees the original ask and two answers, labels hidden, order swapped on a second call. A pair counts only when both orders agree; a split is a tie. The judge is told length is not a virtue and to flag scope growth past the ask.

## Decision rule, fixed before the run

The skill ships as the default deepening step only if both hold:

1. Against **nudge**, it wins more order-consistent pairs than it loses.
2. Its scope-growth flags are no higher than nudge's.

Anything else means the skill stays opt-in or gets cut, and the numbers say which.

## Run

```
node atris/experiments/ambitious-skill/run.js      # writes out/
node atris/experiments/ambitious-skill/judge.js    # writes out/verdicts.json + summary
```

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

## Ship gate, fixed 2026-10-26 before the final exam

The final exam is a fresh task set written by a different model that never saw the skill: 20 mixed tasks plus 8 writing-only tasks, tools on, version 1.2. Every line must hold or nothing ships.

1. **Beats the nudge for real.** Against nudge, wins beat losses with a one-sided sign test p below 0.05 (ties dropped).
2. **Never worse than plain.** Against plain, wins are at least losses. "Better than plain" goes into public copy only if the sign test also clears 0.05.
3. **Same size job.** Scope-growth flags no higher than the nudge.
4. **Writing fixed.** On the 8 writing tasks, wins against plain are at least losses.
5. **Nothing broken.** No skill answer made of fake command calls or under 10 words. *Amended after final exam 2:* the first wording also failed any answer under 50 words, which flagged three correct short answers (a 20-word mileage sum identical to plain, a 37-word molarity conversion, a 42-word landlord text that beat both rivals). Every real break across all runs was fake command calls, and the amended rule still catches all three of them.
6. **Code reviewed.** A second model reviews the branch and every real finding is fixed.
7. **Shipped.** Merged to master and released, with the version read back from npm.

Public copy says only what these numbers say.

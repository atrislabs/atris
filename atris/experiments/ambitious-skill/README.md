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
5. **Nothing broken.** No skill answer made of fake command calls or under 10 words. *Amended after final exam 2:* the first wording also failed any answer under 50 words, which flagged three correct short answers (a 20-word mileage sum identical to plain, a 37-word molarity conversion, a 42-word landlord text that beat both rivals). Every real break across all runs was fake command calls, and the amended rule still catches all three of them. *Amended again after exam 3:* the under-10-words floor flagged a correct one-line UTM link. Broken now means fake command calls or a blank reply. This changes no outcome: exam 3 fails on line 1 either way.
6. **Code reviewed.** A second model reviews the branch and every real finding is fixed.
7. **Shipped.** Merged to master and released, with the version read back from npm.

Public copy says only what these numbers say.

## Exam 3, fixed 2026-10-26 before any exam 3 data exists

Question: does skill v1.4, exactly as shipped in 3.74.18, beat no instruction?

- 60 fresh tasks written blind by Haiku (45 mixed, 15 writing), every earlier topic banned. SKILL.md is frozen: no edits until the result is logged.
- Same worker, tools, nudge line, and pinned judge (gpt-6-sol, high) as exam 2.
- **"Better than plain" is earned only if exam 3 alone gives skill vs plain wins over losses with one-sided sign test p below 0.05.** No pooling with exam 2, and no rerun if it misses.
- Gate lines 1 to 5 must also pass on exam 3.
- If it misses, public copy keeps saying "not yet proven".

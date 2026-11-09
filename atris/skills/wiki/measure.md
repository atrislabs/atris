# Measure recall

How to prove a memory change helped. Back to [SKILL.md](SKILL.md).

## Rules

- Write questions as real tasks in your own words, never copied from index lines. A test that reuses the index wording scores well and proves nothing.
- Give each question a needle: an exact phrase from the note that answers it. The needle still matches after the note moves.
- Keep a held-out set outside the repo that the improver never reads. Score it with `--summary` so the questions are never printed.
- Record the baseline before you change anything. Rerun the held-out set after.
- Report three numbers: answers found, files opened and tokens read. Do not fold them into one score.
- A small exam is noisy. With 25 questions one answer is four points. Call a change real only when it beats that noise.

## Commands

`atris doc-health --recall questions.jsonl` follows links from the boot files and prints each question with what it opened.

`atris doc-health --recall ~/.atris/recall-holdout/<repo>.jsonl --summary` prints totals only.

Each line of the file is `{"id":"r01","q":"I am about to publish, what has to happen first?","needle":"push a v* tag from master"}`.

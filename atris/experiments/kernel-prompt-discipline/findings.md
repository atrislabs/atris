# findings — kernel-prompt-discipline

Independent adversarial review (two subagents, judge ≠ worker) of the metric in
`measure.py`. Reproductions referenced by path. The honest conclusion is the
point of the experiment, not the kept score.

## what the keep/revert loop proved (works)
- full v1 kernel (1237 words) ......... 0.2799
- gut_spine (lean, spine deleted) ..... 0.0857  REVERTED  (substance/coverage gate)
- keyword_stuffer (19-word salad) ..... 0.2000  REVERTED
- spine_kernel (593 words, spine kept)  1.0000  KEPT
The metric is a sound CI pre-filter: it catches bloat and spine-gutting.

## what review broke (reward hacks, all reached 1.0 pre-fix)
1. [HIGH] anti-prompt — a coherent prompt that name-checks every spine marker
   while instructing the model to do the OPPOSITE scored 1.0, tied with the real
   kernel. Substring presence != behavioral encoding. Negation defeats matching.
2. [HIGH] padding — keyword line + Lorem/`blah`*270 cleared the old
   `words>=250` gate at 1.0. The gate measured length, not substance.
3. [MED] substring false hits — `bounded` matched `unbounded`, `human` matched
   `inhuman`, `agent` matched `reagent`, etc.
4. [false negative] a genuinely-good kernel written in synonyms scored 0.0; a
   tight 155-word full-spine kernel scored 0.2 (the 250-word floor punished it).

## fixes applied (cheap holes)
- whole-token matching (`_tok`, regex word boundaries) — kills #3.
- substance gate now keys on vocabulary diversity (`distinct>=80`) + any-level
  headers, not raw length — kills `blah`*270 (now 0.2), raises the bar on padding,
  and stops punishing lean prompts.
- docstring + program.md downgraded from "unfakeable" to "gameable proxy".

## the residual ceiling (cannot be fixed by string matching)
- `/tmp/ceiling_antiprompt.txt` (negates every rule) — STILL 1.0 (coverage 1.0,
  distinct 140).
- `/tmp/ceiling_synonym.txt` (genuinely good, synonyms) — STILL 0.0 (coverage 0).
A regex/keyword metric scores vocabulary + structure, never intent. Prompt-quality
certification needs the model in the loop: a backend A/B on atris2-fast measuring
task verify-pass-rate, or an adversarially-verified LLM-judge. This pack is the
cheap pre-filter that runs first; it is not the judge.

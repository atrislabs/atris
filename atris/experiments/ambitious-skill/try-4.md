# Try 4: one useful question

The idea was to replace four questions with one move a top professional would add, instructing it to keep quick exact requests unchanged and the deliverable the same size.

| Version | Skill vs plain: wins, losses, ties | Skill scope growth |
| --- | --- | --- |
| Starting skill, shared baseline | 9, 12, 9 | 1 of 30 |
| 1: one specific professional move | 8, 16, 6 | 0 of 30 |
| 2: one practical detail for a useful or reliable result | 13, 15, 2 | 0 of 30 |

Version 2 is the best of the two tested changes by win-loss margin. It did not beat plain on this practice set, and these results do not establish performance on new tasks.

The saved baseline used tools. The supplied run command defaults to no tools, which would regenerate plain and nudge answers. To reuse the shared baseline, the scored runs used `env -u ANTHROPIC_API_KEY AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 AMB_TOOLS=Bash,Read,Write,Edit node run.js`, followed by `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js`. The first no-tools attempt was stopped before scoring and the supplied baseline was restored. During version 2 judging, a connection failure interrupted some pairs; the same judge command resumed and completed them.

Losses show that a useful-sounding detail can still be wrong. In version 1, `kayak-buy-vs-rent` invented a resale value, `library-grant-request` treated the entire grant as a book budget, and `kid-carpool-rota` gave the covering family an extra shift. In version 2, `kayak-buy-vs-rent` miscalculated break-even, `hsa-receipt-tally` gave too much weight to administrator approval, and `city-pothole-letter` invented contact details. `capo-chord-shift` missed or mishandled the ambiguity in both versions; `oncall-rotation-design` and `pool-shock-dose` lost both times because the plain answer was more actionable. Concision alone did not ensure correctness or completeness.

Version 2 improved the first attempt's results on `kid-carpool-rota`, `trail-hike-hydration`, and `three-bed-home-listing`, while maintaining zero scope flags. The judging also shows variation on unchanged quick asks, so individual wins should not be attributed to the rewrite without further testing.

The pass-through requirement did not reliably hold in version 2: `tire-psi-conversion` gained a rounding instruction and `sourdough-hydration-math` gained an unrequested salt percentage. The file tells the model to pass quick exact asks unchanged, but these receipts show that instruction is insufficient.

# Try 6: show the work

The idea: use the task's own figures for short, checked calculations and concrete recommendations, without inventing inputs or enlarging the job. Keep checks proportional and avoid requiring missing material when it would not change the answer.

| Version | Skill vs plain: wins, losses, ties | Skill scope growth |
| --- | --- | --- |
| Supplied baseline | 9, 12, 9 | 1 of 30 (oncall-rotation-design) |
| Version 1 | 12, 12, 6 | 1 of 30 (protein-target-split) |

One version was scored. It improved the practice count over the supplied baseline but tied plain on wins and losses, so this is not evidence of a reliable advantage. This is a practice set used to choose the change, not a held-out test.

The saved baseline used `AMB_TOOLS=Bash,Read,Write,Edit`. The brief's command defaults to no tools, which invalidates the saved plain and nudge answers. The first run was stopped and the copied receipts restored; the scored run used `env -u ANTHROPIC_API_KEY AMB_TOOLS=Bash,Read,Write,Edit AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 node run.js`, followed by `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js`. Plain and nudge answers and their mutual verdicts were reused. The summary reported skill vs plain 12, plain 12, tie 6, and skill scope growth 1/30. Quick exact asks `sourdough-hydration-math`, `tire-psi-conversion`, and `rsvp-headcount-formula` passed through word for word; their answers were fresh runs, so their results include answer variation.

Losses: `kayak-buy-vs-rent` relied on an assumed resale value and unverified gear costs; `emergency-fund-months` added an unsupported savings timeline and missed useful financial caveats. `oncall-rotation-design` added tables and assumptions instead of a simple swap; `protein-target-split` added a tracking plan and an unsupported adjustment. `cast-iron-rust-restore` added unnecessary seasoning cycles and unreliable checks. `offsite-cancelled-budget` and `piano-schedule-change` invented details; `wedding-best-man-toast` failed to flag a contradiction. `capo-chord-shift` suggested a misleading chord shape, and `bike-tire-bar-to-psi` gave misleading advice about heat. `rental-car-insurance` missed practical coverage checks. In `tire-psi-conversion`, a pass-through answer incorrectly called an approximation exact.

The numerical rule cannot substitute for sound judgment, accurate details, and a direct answer. Wins on `fence-post-picket-count`, `pool-shock-dose`, and `trail-hike-hydration` suggest concrete work can help, but not every win can be attributed to the rule and the loss pattern shows the remaining weaknesses.

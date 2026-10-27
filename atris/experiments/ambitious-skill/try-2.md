# Try 2: worked examples

Added three short before and after rewrites drawn from losses: cast-iron-rust-restore, oncall-rotation-design, and library-grant-request. They illustrate a practical repair, a fair rotation without invented dates, and a grant request without a misleading per-person figure.

| Version | Skill vs plain, wins / losses / ties | Skill scope growth |
| --- | --- | --- |
| Original practice receipts | 9 / 12 / 9 | 1 / 30 |
| Worked examples, version 1 | 10 / 15 / 5 | 1 / 30 |

Version 1 is the only scored edit, and is retained as the best of the versions tried. It did not beat plain overall and its win-minus-loss margin was worse than the original practice result. This is a practice set used to design the examples, not a blind test of generalization.

The original receipts used tools, although the brief's command does not set them. To retain the original plain and nudge answers, the run used `env -u ANTHROPIC_API_KEY AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 AMB_TOOLS=Bash,Read,Write,Edit node run.js`, followed by `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js`. Both exited 0. All 30 saved plain and nudge answers were checked against the originals and matched.

Losses: cast-iron-rust-restore still added unnecessary checks and seasoning rounds. oncall-rotation-design assumed coverage was needed and its fairness check contradicted its example. emergency-fund-months suggested a target below its own recommendation. logo-placement invented dimensions and produced a clipped placement; photo-shoot-quote added unsupported fees. three-bed-home-listing put inspection advice in the listing, and wedding-best-man-toast repeated a contradiction as fact. piano-schedule-change was less clear about the recurring time. protein-target-split repeated calculations without improving the prescription, and rental-car-insurance missed useful practical checks. offsite-cancelled-budget lost to a more responsive message, though the judge noted an assumption in the winner.

The remaining losses, capo-chord-shift, poster-print-dpi, rsvp-headcount-formula, and tire-psi-conversion, passed through unchanged. Their outcomes reflect fresh answer variation rather than a changed rewrite. The examples did not reliably prevent the same mistakes they illustrated.

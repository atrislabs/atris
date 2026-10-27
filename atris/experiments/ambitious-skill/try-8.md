# Try 8: answer first

The idea: begin with the decision or finished deliverable, then give the reasoning and practical detail needed to use it. Keep checks quiet unless the reader needs them. The second version also avoids invented facts, preserves useful substance, and asks for the constraint that can change a decision.

| Version | Skill vs plain: wins / losses / ties | Skill scope growth |
| --- | --- | --- |
| 1: answer first and quiet checks | 9 / 14 / 7 | 0 / 30 |
| 2: add known facts and deciding detail | 15 / 9 / 6 | 0 / 30 |

The supplied baseline was 9 / 12 / 9. These are practice results, not a fresh blind exam. Both versions were scored with the supplied runner and judge, using `AMB_TOOLS=Bash,Read,Write,Edit` to match the saved baseline hash. Without that setting the runner would regenerate the plain and nudge answers. All 30 saved plain and nudge answers were checked unchanged. One initial run was stopped after this mismatch was discovered, and its changed receipt was restored before scoring.

Losses show that a direct opening is not enough. In version 1, `cast-iron-rust-restore` added damaging or unnecessary steps, `kayak-buy-vs-rent` relied too heavily on uncertain costs and resale, and `seating-chart` invented family sizes. Version 2 won the skillet task and tied the kayak and seating tasks, but still lost `oncall-rotation-design` by claiming a simulation and offering a fallback that might leave a shift uncovered. `photo-shoot-quote` left key prices for the client to calculate. `pool-shock-dose` gave unconditional mixing advice where the product label matters, and `poster-print-dpi` added an incorrect aspect ratio. `wedding-best-man-toast` repeated a contradiction in the supplied story. On `rsvp-headcount-formula`, a quick task passed through unchanged, a wrong initial total hurt the fresh answer despite its later correction. These cases show why concrete checks and uncertainty matter as much as answer order, and why pass-through results still vary between runs.

Commands: `env -u ANTHROPIC_API_KEY AMB_TOOLS=Bash,Read,Write,Edit AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 node run.js` and `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js`, run from this experiment directory. Version 2 is retained with its receipts.

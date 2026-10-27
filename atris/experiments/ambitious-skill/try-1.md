# Try 1: draft, critique, improve

The idea is to have the worker privately draft an answer, critique it as a professional in the field, fix consequential flaws, and deliver only the improved answer. Quick exact asks still pass through unchanged. The rewrite also avoids invented facts and makes checks proportionate instead of requiring a separate check and missing-material request.

| Version | Skill vs plain: wins, losses, ties | Skill scope growth |
| --- | --- | --- |
| Original practice baseline | 9, 12, 9 | See original receipts |
| Draft and critique | 13, 11, 6 | 2 of 30 |

One version was scored. This is a practice-set result, not evidence of a general win on unseen tasks. The saved baseline was produced with tools enabled, so the run used `AMB_TOOLS=Bash,Read,Write,Edit` to preserve its original plain and nudge answers. The command in the brief without that setting regenerates those answers. An initial run without it was discarded before scoring; the original receipts were restored first.

## What the losses taught

- `emergency-fund-months` and `oncall-rotation-design` grew the job: a lengthy income-history exercise and an invented 20-week schedule added work without improving the decision. Both were scope flags.
- `photo-shoot-quote` added unsupported fees, and `three-bed-home-listing` implied an unverified floor plan. A private critique did not consistently remove invented assumptions.
- `rental-car-insurance` repeated checks and made card coverage a prerequisite despite confirmed company coverage. `bike-tire-bar-to-psi` treated normal warming as a limit risk. More detail can introduce consequential errors.
- `cast-iron-rust-restore` prescribed unnecessary seasoning cycles. The plain answer better matched a small repair.
- `wedding-best-man-toast` left a story placeholder and repeated a contradiction in the ask. A finished, speakable answer mattered more than a polished process.
- `poster-print-dpi`, `rsvp-headcount-formula`, and `sourdough-hydration-math` passed through unchanged, but their fresh answers lost on usefulness or concision. This variation is not an effect of the critique instruction.

Run: `env -u ANTHROPIC_API_KEY AMB_TOOLS=Bash,Read,Write,Edit AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 node run.js`, then `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js` from this directory. The judge reported `skill vs plain: skill 13, plain 11, tie 6` and `skill: scope growth flagged on 2/30 tasks`.

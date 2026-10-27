# Try 3: judge's eye

The idea was to turn the blind review reasons into a short, task-specific checklist: correct calculations and claims, direct recommendations, meaningful numbers, honest unknowns, relevant safety conditions, and complete, concise writing. Quick exact asks still pass through unchanged.

| Version | Skill vs plain, wins / losses / ties | Skill scope growth |
| --- | --- | --- |
| Original practice baseline | 9 / 12 / 9 | 1 / 30 |
| Version 1, reviewer checklist | 14 / 12 / 4 | 0 / 30 |

One new version was scored. This is a practice-set result, not proof of improvement on unseen tasks. The saved baseline answers used `AMB_TOOLS=Bash,Read,Write,Edit`; the supplied command without that setting would regenerate them. The run used that setting to preserve the original plain and nudge answers. All 30 pairs were scored in both orders; the original comparison answers were verified unchanged.

Losses show the checklist did not reliably prevent errors: `capo-chord-shift` transposed a chord incorrectly, `pool-shock-dose` made an unsupported product-rate claim, and `rental-car-insurance` added misleading coverage and break-even reasoning. `oncall-rotation-design` and `seating-chart` still invented missing facts and presented unnecessary arrangements as checked. `photo-shoot-quote` left key costs as placeholders instead of offering a usable quote. `poster-print-dpi` lacked the concrete vector-file next step. `city-pothole-letter` and `wedding-best-man-toast` introduced unsupported details; `coworker-condolence-note` and `piano-schedule-change` suffered from repetition or less suitable wording. `rsvp-headcount-formula` passed through unchanged but its fresh answer was less concise, showing ordinary answer variation remains.

Run: `env -u ANTHROPIC_API_KEY AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 AMB_TOOLS=Bash,Read,Write,Edit node run.js` followed by `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js`. Both exited 0.

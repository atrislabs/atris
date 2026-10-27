# Try 10

## Idea

Use a grounded, minimal rewrite: preserve the actual job and supplied facts, identify the most consequential practical improvement, and avoid turning guesses or checks into a new project. Quick exact asks pass through unchanged. Version 2 permits a concrete check or caveat when it helps the person act, and explicitly warns against invented personal claims and silently resolving conflicting details.

## Practice results

| Version | Skill vs plain: wins / losses / ties | Skill scope growth |
| --- | --- | --- |
| 1 | 11 / 12 / 7 | 0 / 30 |
| 2 | 15 / 11 / 4 | 0 / 30 |

Version 2 is retained. This is a practice set used for iteration, not evidence of performance on unseen tasks. The original plain and nudge answers were preserved for all 30 tasks. The supplied baseline used `AMB_TOOLS=Bash,Read,Write,Edit`, so both runs used that setting to preserve the baseline; the printed setup command alone would otherwise regenerate it. Scores used `env -u ANTHROPIC_API_KEY AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 AMB_TOOLS=Bash,Read,Write,Edit node run.js` followed by `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js`.

## Lessons from the losses

- `kid-carpool-rota`: a valid schedule also needs practical pickup authorization, child-seat and backup details. `oncall-rotation-design`: a fair rotation needs a concrete swap that preserves fairness, without extra unresolved examples.
- `rental-car-insurance`: conditional coverage advice must not assume a policy is primary or a waiver refundable. `poster-print-dpi`: give the practical next step, such as requesting the vector original.
- `coworker-condolence-note` and `piano-schedule-change`: natural, brief writing can beat a rewrite that inserts an awkward detail or unnecessary alternatives. `three-bed-home-listing`: do not infer unprovided facts about the property's condition or price. `wedding-best-man-toast`: do not resolve conflicting details by inventing a relationship.
- `capo-chord-shift`: a passed-through ask can still yield contradictory advice. `rsvp-headcount-formula`: the correct formula can lose when surrounded by unnecessary explanation. `protein-target-split`: avoid overconfident claims about physiology or prescriptive timing. Pass-through answers are fresh model samples, so their wins and losses also reflect sampling variation.

# Try 7: the named expert

Name the specific working role and a concrete standard for the recipient in the rewritten task, then have the worker answer as that expert. Preserve exact pass-through for quick asks and the same deliverable and scope.

| Version | Skill vs plain (wins, losses, ties) | Skill scope growth |
| --- | --- | --- |
| 1 | 12, 12, 6 | 1 of 30 |
| 2 | Incomplete, not scored | Not available |

Version 1 improved on the supplied practice baseline of 9 wins, 12 losses, and 9 ties, but did not beat plain overall. It remains the best completely scored version. Its skill vs nudge result was 15 wins, 11 losses, and 4 ties. The practice set is used for tuning, so this is not independent evidence of general improvement.

Version 2 asked for shorter, more proportionate answers, natural use of personal details, and no invented schedules. The answers completed, but the judge repeatedly failed with network and workspace routing errors before scoring the full set. Its partial verdicts are not a score, and version 1 was restored along with its receipts.

## Losses and lessons

- `oncall-rotation-design` and `logo-placement`: invented schedules and speculative measurements buried a practical answer. A named expert still needs to work from the facts supplied and keep detail proportionate.
- `emergency-fund-months` and `rental-car-insurance`: a plausible extra shortcut or confident qualification can be less sound than the plain answer. Expert framing does not verify financial or coverage assumptions.
- `coworker-condolence-note`, `piano-schedule-change`, and `vet-tech-linkedin-bio`: warmth, brevity, and requested length matter. The expert label alone did not reliably preserve them.
- `wedding-best-man-toast`: the answer repeated an ambiguous family relationship instead of flagging it. The plain answer handled that uncertainty better.
- `bike-tire-bar-to-psi` and `rsvp-headcount-formula` were passed through unchanged. Fresh-answer variation can affect the result even when the skill makes no rewrite.

Commands: `env -u ANTHROPIC_API_KEY AMB_TOOLS=Bash,Read,Write,Edit AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 node run.js` and `AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js`, from this experiment folder. The tool setting matches the supplied baseline and preserves its plain and nudge answers and verdicts. An earlier incomplete attempt without that setting was discarded because it regenerated the comparison answers.

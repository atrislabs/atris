# README ambiguities found while writing the goldens

Format: rule | readings | chosen. "Avoided" means no golden file depends on it, so a surface can pick either until the README says.

- mission_ended, step-like events on an unknown mission | mission_ended creates the mission (like step/kept/reverted) or is only applied to an existing one | avoided; every golden starts a mission before ending it. The README says "created if new" for some events but not mission_ended.
- budget_reserved / budget_released for a mission id that does not exist | reservation is stored by id only, or it also creates a proposed mission | stored by id only (no mission created); only existing missions are reserved in goldens.
- mission_proposed on a mission that already exists | resets status to proposed, or leaves status and only fills member/estimate | avoided.
- mission_claimed by the same mission that already holds the key | duplicate_claim against itself, or a harmless no-op | avoided.
- mission_started / mission_vetoed on an ended, dropped or vetoed mission | status is overwritten, or terminal statuses stick | avoided.
- mission_started with a different member (second_assignee) | status still becomes running, or the whole event is ignored | still becomes running; only the member is unchanged (claims-vetoes-assignees).
- mission_vetoed on an unknown mission | create it as vetoed, or ignore | avoided.
- ask_answered by an agent on an unknown or closed ask | ask_answered_by_agent or unknown_ask, or both | avoided (agent answers only an open ask; human answers unknown and closed asks).
- ask_opened with an ask id that is already open | second entry, or ignored | avoided.
- Money in the view for estimate_usd | printed as given (2.675), or through cents like every other amount (2.68) | through cents (money-rounding-and-duplicate-id).
- confidence when the latest run passed on a campaign that is not standing and was not finished by the judge (for example stopped, then a late pass) | stronger/leaning by the run history, or open | avoided; the "(standing campaigns)" note in the README reads as explanation, not a condition.
- confidence for a standing campaign finished by stopped with a passing latest run | answered (finished) or leaning (judge did not finish it) | leaning, because answered is only "finished by the judge" (stopped-standing).
- Warnings for events after finish (a second stopped, a done from anyone, a passing judge_ran) | silent, or a new warning code | avoided; the README lists no code for them.
- Seat object in campaign_started without a role key (schema allows it) | role null, or the member's own job name | role null; not exercised.
- Duplicate seats inside campaign_started data.seats | deduped like seat_filled, or kept as written | avoided.
- last_judge.at | the event's at string verbatim, or normalized to UTC Z form | verbatim; goldens use Z strings for judge events so both agree.
- Sort tie rules | seq compared as a number, origin and id as plain strings | numeric seq, plain string order for origin and id (README says "plain string order" only for id); the order goldens tie on `at` and rely on origin cloud < laptop.
- decide: "estimate (0 when null) fits in available" | fits means estimate <= available, or < available; and a null estimate against negative available | inclusive (<=); 0 <= -3 is false so it does not fit (decide-cases.json).
- decide: reads view.state or recomputes from fields | the README says "when done", "when out of budget", "when paused" in state terms | goldens use internally consistent views, so both agree.
- decide: order between "wait: budget" and "wait: missions running" when both apply | literal list order, budget first | budget first (decide-cases.json).
- Reservation on a mission that already ended | stays open or is released immediately | avoided.

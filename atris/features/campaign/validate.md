# Campaign — Validate

> Proof that Campaign works, checked by someone other than the builder.

---

## Acceptance Checks

Run each in a fresh temp workspace (`atris init`), with real members, not mocks.

1. **Start and show.** `atris campaign start "Which sourcing channel produces hires?" --owner scout --judge "hire_rate>=0.2" --budget 300` then `atris campaign show <id>` shows owner, judge, budget, answer `open`, state `running`.
2. **Missions link.** Two missions started with `--campaign <id>` by two different members both appear under the campaign, and their spend adds up in `budget.spent`.
3. **Judge decides, not the model.** A mission reports success while the judge fails. The campaign stays `running`. Only a passing judge or `atris campaign stop` makes it `done`.
4. **Replay.** Delete every computed field from `campaigns.jsonl`, fold the events again, and the state, answer, confidence, and spend come back identical.
5. **Claims.** Two seated members propose the same idea. One mission is created, and the second proposal is recorded as dropped.
6. **Budget.** Set the remaining budget below `per_mission`. The next mission refuses to start with a plain reason.
7. **No-reload line.** A step that would contact a real person opens an Ask. That campaign shows `needs_you`. A second campaign keeps running. `atris decide` answers it, and the first campaign resumes.
8. **Many at once.** Three campaigns run in parallel. One member holds seats in two of them. `atris campaign` shows all three on one screen with what needs you.
9. **Wish constructor.** `atris wish "I wish I knew which channel produces hires" --metric "hire_rate>=0.2"` creates a campaign whose judge is that metric, asking at most one gap question at a time.
10. **Purposes.** `atris campaign` lists each member's `MISSION.md` with a `## Check` as a standing purpose.
11. **No regressions.** The existing mission, wish, fleet, and member test suites pass unchanged.
12. **Judge must fail first.** Starting a non-standing campaign whose judge already passes is refused with "already done, write a judge that fails first."
13. **No budget works.** A campaign with no budget runs on subscription engines, logs token and quota usage per mission, and turns any money spend into an ask.
14. **Notes.** A one-on-one note is saved only after the member's repeat-back is confirmed; it takes effect at the next shift, not mid-mission; a fact note older than 7 days is flagged "still true?".
15. **Shifts.** Shifts end with a recorded reason (mission done, context, stalled, cap, quota) and the next shift starts from a fresh briefing.
17. **A "no" answer finishes.** An answer campaign whose judge prints `{"verdict":"no"}` three runs in a row on unseen data ends as done with answer no.
18. **Abandoned missions.** Kill a mission's process past its lease: `mission_abandoned` is written and its reservation released.
19. **Target claims.** Two proposals with different wording that touch the same files collide; only one runs.
20. **Asks.** An open ask blocks only its mission; after 3 days it resolves to no with `ask_expired`.
21. **Clean ending.** On done, pending proposals are cancelled, asks closed, reservations released, and a `concluded` summary appears in atris/wiki.
16. **Every surface.** For "Campaign ships across Atris": start, watch, coach, and finish a campaign from the CLI, desktop, web, and Terrace (iOS).

## First Real Run

The first campaign, "Campaign ships across Atris" (`first-campaign.md`), is itself the proof: it is done when its judge passes. After that, run one real campaign on Pallet recruiting with Keshav's approval:

- Title: "Which sourcing channel actually produces hires?"
- Raw material: the read-only recruiting ingest (`atrisos-backend/backend/services/recruiting_intelligence_ingest.py`).
- Judge: predicted hire rate by channel checked against Greenhouse outcomes the team did not see.
- No candidate gets contacted. Any outreach step is an Ask.

Record the receipt path here when it runs.

## Results

| Date | Check | Result | Receipt |
|---|---|---|---|
| | | | |

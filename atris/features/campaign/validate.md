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

## First Real Run

After the checks pass, run one real campaign on Pallet recruiting with Keshav's approval:

- Title: "Which sourcing channel actually produces hires?"
- Raw material: the read-only recruiting ingest (`atrisos-backend/backend/services/recruiting_intelligence_ingest.py`).
- Judge: predicted hire rate by channel checked against Greenhouse outcomes the team did not see.
- No candidate gets contacted. Any outreach step is an Ask.

Record the receipt path here when it runs.

## Results

| Date | Check | Result | Receipt |
|---|---|---|---|
| | | | |

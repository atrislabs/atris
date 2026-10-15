# Campaign: Campaign ships across Atris

> Run by hand (build.md Phase 0.5) until `atris campaign` exists. Then import this file as the first real campaign.

```yaml
campaign:
  id: cmp-campaign
  title: "Campaign ships across Atris"
  judge: "npm run validate:campaign"     # does not exist yet; mission 1 builds it; it must fail today
  owner: mission-lead
  bet: "Mostly wiring on every surface. Wrong if any surface needs its own new runner."
  # no budget: subscriptions only; any money spend is an ask
  seats:
    cli:      [builder, validator]                                     # ~/arena/empire/atris-cli
    backend:  [backend-feature-owner, backend-independent-validator]   # ~/arena/empire/atrisos-backend
    desktop:  [interface-dev, frontend-dev]                            # ~/arena/empire/atris-desktop-v2
    web:      [atris-frontend, validator]                              # ~/arena/empire/atrisos-web
    ios:      [ios-engineer, ios-quality-engineer]                     # ~/arena/empire/terrace
```

## How to run it by hand

- Every mission for this campaign puts `campaign:cmp-campaign` in its objective and lives in its own repo's normal task and mission system.
- Append one line per event to the log below: date, who, what happened, link to the receipt. Never edit old lines.
- The lead (mission-lead) approves or vetoes proposed missions by writing an event line.
- Any step that spends money or messages a real person is an ask: write it as `ASK` and wait for Keshav.
- Write pain points in `by-hand.md` as they happen. That file decides the schema changes before Phase 1.

## First missions (lead may change these)

1. **Build the judge.** `npm run validate:campaign` in atris-cli runs the checks in `validate.md` that can run today and fails on the rest. Owner: builder. Check: it exits non-zero today.
2. **Storage groundwork.** build.md Phase -1. Owner: builder. Check: concurrency and crash-injection tests pass.
3. **Backend map to tasks.** Turn idea.md "Backend and Cloud Agents" gaps into backend tasks. Owner: backend-feature-owner. Check: tasks exist with file:line pointers.
4. **Surface scouting.** Desktop, web, and Terrace each name where a campaign screen would live and what it reads. Owners: interface-dev, atris-frontend, ios-engineer. Check: one short note per surface in this folder.

## Event log

| When | Who | Event | Receipt |
|---|---|---|---|
| 2026-10-15 | keshav | campaign_started | this file |

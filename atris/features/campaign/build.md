# Campaign — Build Plan

> **For the builder.** Read `idea.md` first. The design is settled; this file is the order to build it in. One phase per PR. Each phase ends with its check passing.

---

## Overview

Add Campaign as a durable, event-sourced struct above Mission, shared by the CLI and backend, with members seated in it and missions linked to it. No UI in this plan beyond the CLI status screen.

---

## Phase 0 — Schema (the contract)

**Create** `lib/campaign-schema.js` (or a JSON Schema file it loads) with the struct, event types, and actions from `idea.md` → The Struct.

- Export `CAMPAIGN_FIELDS`, `EVENT_TYPES`, `ACTIONS`, `CONFIDENCE = ['open','leaning','stronger','answered']`, `STATES`.
- Export `validateCampaign(record)` and `validateEvent(event)`.

Check: `node --test test/campaign-schema.test.js` covers a valid campaign, a missing judge, a nested parent two levels deep (rejected), and an unknown event type (rejected).

## Phase 1 — Store and fold

**Create** `lib/campaign-store.js`.

- Append records to `.atris/state/campaigns.jsonl` and events to `.atris/state/campaign_events.jsonl` (same atomic-append style as `missions.jsonl` / `mission_events.jsonl`).
- `fold(events) → { state, answer, confidence, budget.spent, asks, missions }`. Computed fields are never written by hand.
- `listCampaigns(root)`, `getCampaign(root, id)` return folded views.

Check: a replay test. Write events, fold, delete computed fields, fold again, and get identical output.

## Phase 2 — CLI verbs

**Create** `commands/campaign.js`, register it in the command table and help.

```text
atris campaign                         one screen: every campaign, state, current mission, what needs you
atris campaign start "<title>" --owner <member> --judge "<metric or cmd>" --budget <n> [--kind answer|outcome] [--stop "..."] [--parent <id>]
atris campaign show <id>               bet, judge, answer + confidence, budget, seats, missions, open asks
atris campaign seat <id> <member> --role <role>
atris campaign bet <id> "<bet>" --wrong-if "<what would prove it wrong>"
atris campaign pause|resume|stop <id>
atris campaign judge <id>              run the judge now, record judge_ran, update answer
```

Plain-language output, matching the rest of the CLI. `--json` on every verb.

Check: `node --test test/campaign-command.test.js` for each verb against a temp workspace.

## Phase 3 — Missions belong to campaigns

**Modify** `commands/mission.js`:

- `atris mission start ... --campaign <id>` writes `campaign_id` on the mission and emits `mission_started` on the campaign.
- Mission completion emits `mission_ended` with its receipt path and outcome (kept, reverted, failed).
- Before start, reserve `per_mission` budget (`budget_reserved`). If the tank cannot cover it, refuse with a plain reason.
- A mission with no campaign still works exactly as today.

Check: existing mission tests still pass, plus a test that a linked mission shows up in `atris campaign show` and its spend is reflected after completion.

## Phase 4 — The judge

**Create** `lib/campaign-judge.js`.

- A judge is either a metric expression (reuse `parseMetricExpression` from `commands/wish.js`) or a shell command whose exit code decides.
- `judge_ran` events record the command, output summary, and pass/fail.
- Only a passing judge or an explicit `stop` moves a campaign to `done`. A model claim never does.
- Confidence moves from judge history: no runs → open, passing on the latest run → leaning, consistent across runs → stronger, judge's stop condition met → answered.

Check: a test where a mission reports success but the judge fails, and the campaign stays running.

## Phase 5 — Asks (the no-reload line)

- Any mission step tagged as irreversible (money, contacting a real person, deploy, external write) opens an Ask on its campaign instead of running.
- `atris decide` lists and answers campaign asks next to mission asks.
- An open ask moves only that campaign to `needs_you`. Others keep running.

Check: a test that an open ask blocks one campaign and not another.

## Phase 6 — Seats plan their own missions (blackboard)

**Modify** `lib/member-self-next-job.js`:

- When a member is idle, also read every campaign where it holds a seat. Propose one mission per campaign from its role, the bet, and recent events.
- Emit `mission_proposed`, then `mission_claimed` with a claim key (campaign id + normalized idea). A second proposal with the same key is dropped.
- Keep today's caps (one open self-written job per member, 12 a day). Add a per-campaign cap.
- The owner can veto a proposed mission (`atris campaign veto <id> <mission>`). Default is run unless vetoed.

Check: two seated members propose the same idea; only one mission is created.

## Phase 7 — Scope fleet and the team loop to campaigns

- `atris mission run --fleet --campaign <id>` runs only that campaign's claimed missions in parallel.
- The team loop (Team awake) picks across campaigns by budget left, open asks, and age. It leases engines from `atris/ROSTER.md` as today.

Check: `--fleet --campaign` dry-run lists only that campaign's missions.

## Phase 8 — Wish as constructor

**Modify** `lib/wish-delegate.js`:

- Wish decides: one mission, or a campaign. A campaign wish asks the gaps one at a time: title, owner, bet and what would prove it wrong, judge, budget, stop. Add one question for raw material ("what's the rawest thing we can look at?").
- `--metric` becomes the campaign judge.

Check: a wish with `--metric` creates a campaign whose judge is that metric.

## Phase 9 — Standing campaigns from MISSION.md (read-only first)

- Treat each `atris/team/<member>/MISSION.md` with a `## Check` as a standing campaign view (`standing: true`), without migrating files.
- `atris campaign` lists them under "purposes."

Check: health-sentinel's purpose appears with its check as the judge.

## Phase 10 — Backend mirror and renames (separate repo, separate PR)

- `atrisos-backend`: add `/api/campaigns/schema` and `/api/campaigns/preview` next to the mission routes, generated from the same schema.
- Rename Rainmaker and command-center cold-email "campaigns" to "sequences" in code and copy.
- CLI: rename loose "quest" wording in `commands/xp.js` ("Next quest") and `commands/business-sync.js` ("quest gate") to plain words.

Check: backend schema route returns the same field list as `lib/campaign-schema.js`.

---

## Files Touched (expected)

**Created:** `lib/campaign-schema.js`, `lib/campaign-store.js`, `lib/campaign-judge.js`, `commands/campaign.js`, tests for each.

**Modified:** `commands/mission.js`, `lib/member-self-next-job.js`, `lib/fleet.js`, `lib/wish-delegate.js`, the decide command, the command table and help, `commands/xp.js`, `commands/business-sync.js`.

---

## Stop Rules for the Builder

- Do not change how missions run when no campaign is involved.
- Do not add UI beyond the CLI status screen.
- Do not touch billing.
- Ask Keshav before renaming `MISSION.md` files or changing the meaning of `parent_mission_id`.

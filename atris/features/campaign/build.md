# Campaign: Build Plan

> **For the builder.** Read `idea.md` first. The design is settled; this file is the order to build it in. One phase per PR. Each phase ends with its check passing.

---

## Overview

Add Campaign as a durable, event-sourced struct above Mission, shared by the CLI and backend, with members seated in it and missions linked to it. No UI in this plan beyond the CLI status screen.

---

## Phase -1: Fix the storage Campaign will stand on (from Astra review, 2026-10-15)

A read-only review by Astra (codex `gpt-6-astra`, receipt `atris-desktop-v2/atris/runs/engine-ask-20261015082757758-9544-5527bb9c.json`) read today's mission storage and found four problems Campaign would inherit. Fix them first, or build the campaign store so it does not share them:

1. **Lost writes (high).** Ledger compaction checks size, then renames a replacement file, with no lock shared with appends, so a concurrent append can be lost. `lib/mission-ledger-compact.js` (`compactMissionLedger`), `commands/mission.js` (`saveMission`). Fix: one ledger-wide lock for every append and compaction, or a transactional store.
2. **Half-saved state (high).** A mission snapshot and its event are separate writes, so a crash between them leaves a transition with no event. `commands/mission.js` `saveMission`. Fix: one authoritative record with a durable event id, plus an idempotent reconcile path, before campaign reservations depend on it.
3. **No event identity (medium).** Mission events carry a schema label but no unique id or sequence, and state is read from the latest snapshot, not replayed. `commands/mission.js` `loadMissionMap`, `appendEvent`. Fix: campaign events get an id, a serialized sequence number, an expected-version check on write, a replay version, and written migration rules for when a fold rule changes.
4. **Silent drops (medium).** `readJsonLines` in `commands/mission.js` skips malformed lines, which would hide a lost claim or reservation. Fix: fail closed on corruption in the middle of a file; recover only an incomplete last line, under the lock.

Also decide now: what releases a budget reservation when a mission crashes (a lease that expires, recorded as `budget_released`).

Check: a concurrency test with two processes appending and compacting at once loses no lines; a crash-injection test leaves no snapshot without its event.

## Phase 0: Schema (the contract)

**Create** `lib/campaign-schema.js` (or a JSON Schema file it loads) with the struct, event types, and actions from `idea.md` → The Struct.

- Export `CAMPAIGN_FIELDS`, `EVENT_TYPES`, `ACTIONS`, `CONFIDENCE = ['open','leaning','stronger','answered']`, `STATES`.
- Export `validateCampaign(record)` and `validateEvent(event)`.

Check: `node --test test/campaign-schema.test.js` covers a valid campaign, a missing judge, a nested parent two levels deep (rejected), and an unknown event type (rejected).

## Phase 0.5: Run the first campaign by hand (before Phase 1)

Run "Campaign ships across Atris" for one week using `first-campaign.md` in this folder (title, lead, seats per repo, bet, judge) and missions tagged `campaign:cmp-campaign` in their objective. The first mission builds the judge (`npm run validate:campaign`), and it must fail today. Log every pain point in this folder as `by-hand.md`. Adjust the schema before building the store.

Check: `by-hand.md` exists with at least five concrete observations, and the schema PR cites them.

## Phase 1: Store and fold

**Create** `lib/campaign-store.js`.

- Store adapter over SQLite at `<workspace>/.atris/state/atris.db` (tables `campaigns`, `missions`, `events`; WAL mode; one transaction per append). Events carry a globally unique id, the origin computer, and a per-origin sequence. An in-memory adapter for tests.
- Keep the core pure: `fold(events)` and `decide(state)` take no I/O. Ship golden event logs with expected folded state in `test/fixtures/campaign/`; the backend's Python fold must pass the same files.
- `fold(events) → { state, answer, confidence, budget.spent, asks, missions }`. Computed fields are never written by hand.
- `listCampaigns(root)`, `getCampaign(root, id)` return folded views.

Check: a replay test. Write events, fold, delete computed fields, fold again, and get identical output.

## Phase 2: CLI verbs

**Create** `commands/campaign.js`, register it in the command table and help.

```text
atris campaign                         one screen: every campaign, state, current mission, what needs you
atris campaign start "<title>" --judge "<metric or cmd>" [--owner <member>] [--seats a,b] [--bet "..."] [--budget <amount> --unit tokens|credits|dollars|quota] [--standing]
atris campaign show <id>               bet, judge, answer + confidence, budget, seats, missions, open asks
atris campaign seat <id> <member> --role <role>
atris campaign bet <id> "<bet>" --wrong-if "<what would prove it wrong>"
atris campaign pause|resume|stop <id>
atris campaign judge <id>              run the judge now, record judge_ran, update answer
```

Plain-language output, matching the rest of the CLI. `--json` on every verb.

Check: `node --test test/campaign-command.test.js` for each verb against a temp workspace.

## Phase 3: Missions belong to campaigns

**Modify** `commands/mission.js`:

- `atris mission start ... --campaign <id>` writes `campaign_id` on the mission and emits `mission_started` on the campaign.
- Mission completion emits `mission_ended` with its receipt path and outcome (kept, reverted, failed, or fault when the job never ran).
- A job that did real work but stopped short keeps its own outcome, and the view marks it `credited: true` when the very next judge reading passes. Credited jobs do not count toward a member's losing streak.
- If the campaign has a budget, reserve the mission's share before start (`budget_reserved`); if it cannot be covered, refuse with a plain reason. With no budget, skip reservation.
- `mission_ended` carries usage from the receipt: tokens, quota, and money if any.
- A mission with no campaign still works exactly as today.

Check: existing mission tests still pass, plus a test that a linked mission shows up in `atris campaign show` and its spend is reflected after completion.

## Phase 4: The judge

**Create** `lib/campaign-judge.js`.

- A judge is either a metric expression (reuse `parseMetricExpression` from `commands/wish.js`) or a shell command whose exit code decides.
- `judge_ran` events record the command, output summary, and pass/fail.
- Only a passing judge or an explicit `stop` moves a campaign to `done`. A model claim never does.
- Confidence moves from judge history: no runs → open, passing on the latest run → leaning, consistent across runs → stronger, judge's stop condition met → answered.

Check: a test where a mission reports success but the judge fails, and the campaign stays running.

## Phase 5: Asks (the no-reload line)

- Any mission step tagged as irreversible (money, contacting a real person, deploy, external write) opens an Ask on its campaign instead of running.
- `atris decide` lists and answers campaign asks next to mission asks.
- An open ask moves only that campaign to `needs_you`. Others keep running.

Check: a test that an open ask blocks one campaign and not another.

## Phase 6: Seats plan their own missions (blackboard)

**Modify** `lib/member-self-next-job.js`:

- When a member is idle, also read every campaign where it holds a seat. Propose one mission per campaign from its role, the bet, and recent events.
- Emit `mission_proposed`, then `mission_claimed` with a claim key (campaign id + normalized idea). A second proposal with the same key is dropped.
- Keep today's caps (one open self-written job per member, 12 a day). Add a per-campaign cap.
- The owner can veto a proposed mission (`atris campaign veto <id> <mission>`). Default is run unless vetoed.

Check: two seated members propose the same idea; only one mission is created.

## Phase 7: Scope fleet and the team loop to campaigns

- `atris mission run --fleet --campaign <id>` runs only that campaign's claimed missions in parallel.
- The team loop (Team awake) picks across campaigns by budget left, open asks, and age. It leases engines from `atris/ROSTER.md` as today.

Check: `--fleet --campaign` dry-run lists only that campaign's missions.

## Phase 8: Wish as constructor

**Modify** `lib/wish-delegate.js`:

- Wish decides: one mission, or a campaign. A campaign wish asks the gaps one at a time: title, owner, bet and what would prove it wrong, judge, budget, stop. Add one question for raw material ("what's the rawest thing we can look at?").
- `--metric` becomes the campaign judge.

Check: a wish with `--metric` creates a campaign whose judge is that metric.

## Phase 9: Standing campaigns from MISSION.md (read-only first)

- Treat each `atris/team/<member>/MISSION.md` with a `## Check` as a standing campaign view (`standing: true`), without migrating files.
- `atris campaign` lists them under "purposes."

Check: health-sentinel's purpose appears with its check as the judge.

## Phase 9.5: One-on-ones, notes, and shifts

- `atris campaign talk <member>`: a one-on-one. The member summarizes its recent work; the human gives a note; the member repeats it back as one concrete rule; the human confirms. Saves `note_given { member, scope, kind, rule, why, source, expires }`.
- Notes load at the member's next shift start, never mid-mission. Default scope "from now on" (member lessons); `--just-this-campaign` for one-offs.
- Kind `taste` never expires; kind `fact` expires after 7 days unless re-checked, and stores where to check it, not only the value. Expired notes surface as "still true?" in the shift briefing.
- Shift end at: mission done, context about 60% full, no progress for several steps, or a ~50-minute cap; or quota exhausted (rest until reset). Write `shift_ended` with reason and usage. The Orb (team loop) then picks continue, hand off, or pause.
- Cap notes per member; prune notes whose before/after review scores show no help.

Check: a vague note without a confirmed repeat-back is not saved; a fact note older than 7 days appears as "still true?" at the next shift; a shift ends with reason `context` when the context threshold is hit in a test harness.

## Phase 10: Backend mirror and renames (separate repo, separate PR)

- `atrisos-backend`: add `/api/campaigns/schema` and `/api/campaigns/preview` next to the mission routes, generated from the same schema.
- Tables `campaigns` and `campaign_events` (copy the `timeline_events` idempotent-append pattern: unique on campaign and event id).
- Add `campaign_id` to `Atris2MissionRequest` (`backend/routers/atris2_router.py:1026`) and the mission row; a child mission's `campaign_id` must equal its parent's.
- Reserve each mission from a campaign budget pool using the existing `budget_hold` path (`backend/services/mission_runner_service.py`).
- Extend the mission checks step into the campaign judge for cloud campaigns, and record `judge_ran` server-side.
- Python fold passes the shared golden logs from Phase 1.
- Rename Rainmaker and command-center cold-email "campaigns" to "sequences" in code and copy.
- CLI: rename loose "quest" wording in `commands/xp.js` ("Next quest") and `commands/business-sync.js` ("quest gate") to plain words.

Check: backend schema route returns the same field list as `lib/campaign-schema.js`.

## Phase 11: Sync, homes, and one harness everywhere

- Shared member id issued by the backend; local `MEMBER.md` stores it. Replace name matching (`member_projection_service.py`).
- Outbox and inbox: computers push new events and pull missing ones by id. Duplicates are ignored.
- Home lease: the home renews a lease in the backend; on expiry another computer may take over and log `home_moved`.
- Business EC2 computers already reinstall the CLI on wake (`backend/services/ai_computer_ec2_service.py`). Make the campaign store and sync part of that bootstrap so every business computer can be a home.
- Trust boundary: money, ask approvals, done rulings for cloud campaigns, and identity are enforced by the backend, never by the computer's own SQLite.

Check: a campaign started on a laptop keeps running on a business EC2 computer after the laptop's lease expires, and its folded state is identical on both and in the backend.

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

# Campaign: the struct for long-horizon agent work

> **Status:** planning (design settled, not built)
> **Created:** 2026-10-15
> **Last Updated:** 2026-10-15 (added delegation ladder, standard, clarification learning, subagents, storage groundwork)
> **Decided by:** Keshav, in a design session on 2026-10-14 and 2026-10-15
> **Build owner:** to be assigned (see `build.md`)

---

## One Line

You make a wish, it starts a campaign, and the campaign runs missions until the judge says it's done.

```text
Wish       the verb that sets work up         "I wish I knew which sourcing channel produces hires"
Campaign   lasts, many members, one judge      runs until the judge or a human says done
Mission    one member, one run, it ends        (today's Mission, unchanged)
Task       one step inside a mission           (today's task, unchanged)
```

Inspiration is the "Start Campaign" button in Halo 3 and Half-Life 2: a campaign is the whole story, and it is made of missions. Take the feel from games, not their rules. A game runs one campaign at a time, in order. Atris runs many campaigns side by side, each with many members, and one member can sit in several.

---

## Problem Statement

Atris has the pieces for long-horizon work: wishes, missions, tasks, members, engines, receipts, the team loop, experiment packs. It has no object that lasts across missions.

So today:

- A mission ends, and the bigger goal it served lives in someone's head, a `MISSION.md`, or a chat.
- `parent_mission_id` only means "the mission that came before" (a chain), not "part of." A parent mission has nothing to run, so long chains leave ghost missions behind (orb lessons on 2026-10-13 hit this).
- "Mission" means three things: a member's lifelong purpose (`MISSION.md`), a finite run (`.atris/state/missions.jsonl`), and the Codex native goal slot.
- Several members cannot work one goal together. A mission runs as its owner, one task at a time. `atris mission run --fleet` runs tasks in parallel, but across the whole board, not one goal.
- Every interface (CLI, desktop, backend, Slack) has to reassemble the state from scattered files.

We want one struct that the CLI, backend, desktop, and every future interface share.

---

## Solution Design

Add **Campaign** as a first-class Atris object. It is a durable workflow: it holds a desired state (the judge passes) and keeps starting finite missions until the real state matches. It never runs code itself. Missions do the work.

The architecture is a game engine split from its screens. The orchestration framework is the engine, the Campaign is the save file, events are the play-by-play, and actions are the controller. The lab game, GM mode, a plain dashboard, Slack, and voice are all screens over the same struct.

```text
WHO (lives forever)          WORK (has a lifetime)               COMPUTE (interchangeable)

Member ──owns──────────────▶ Campaign   lasts, never runs code, only decides
   │                            │  judge · budget · stop · answer
   └──holds a seat (role)───────┤
                                │ spawns
   ──is assigned─────────────▶ Mission    one member, one run, it ends ──runs on──▶ Engine
                                │
                             Ask        a decision only a human can make
                             Event      append-only; everything else is computed from it
```

Prior art to borrow from: Temporal workflows (durable workflow, activities, signals, queries), Kubernetes controllers (desired state plus a reconcile loop that spawns jobs), the blackboard pattern (many agents read and write one shared board), and event sourcing with CQRS (state is a fold over events, screens are read models).

---

## The Struct (final, judged by Fable 2026-10-15)

A person or agent writes only this. Two fields are required: `title` and `judge`.

```yaml
campaign:
  title: "Campaign works in Atris"          # plain words, the only name humans use
  judge: "npm run validate:campaign"        # one command, exit 0 means the judge passes
  budget: { amount: 300, unit: credits }    # optional; unit is tokens, credits, dollars, or quota; none = subscriptions only
  owner: mission-lead                       # optional; the campaign lead; the Orb picks one if left out
  seats: [builder, validator]               # optional; role comes from each member's own job
  bet: "Mostly wiring. Wrong if phase 10 needs a new runner."   # optional; hypothesis and what proves it wrong
  standing: false                           # optional; true means a passing judge is health, not the end
```

Not written by hand:

- `id`: generated at `campaign_started`.
- `stop`: judge passes (unless standing), budget spent, or a `stopped` event.
- `state`, `answer` and confidence, `spent`, `asks`, `missions`: folded from events, never stored.
- `created_from`: payload of `campaign_started`.
- `parent`: an `attached` event written by an action.
- Per-mission budget: each mission writes `budget_reserved` when it starts, sized from the mission.
- No budget is the default. Work on subscription engines costs no extra money, and any real money spend becomes an ask (the no-reload line). Budget is a plug: each unit (tokens, Atris credits, dollars, subscription quota) has its own meter. Token and quota usage is logged on every mission either way, so waste is measured, not guessed.
- `--metric "name>=target"` is shorthand for a judge command (`lib/wish-delegate.js` turns it into `backend/scripts/metric_verify.py`).
- Answer campaigns need no extra field. The judge may print one JSON line `{"verdict": "yes|no|unclear", "value": <number>, "proof": "<uri>"}` (`backend/scripts/metric_verify.py` already prints JSON). Outcome campaigns use the exit code. An answer campaign is done when the same verdict (yes or no) holds 3 judge runs in a row on data the team has not seen. Confidence folds from judge history.
- The judge runs after each mission ends and on demand, never more than once per mission end.

Two rules from the review:

1. **Every mission reports its usage.** `mission_ended` carries tokens, quota, and any money from the receipt. A budget nobody can measure is slop. (Local missions today have time tiers, not dollars; only the backend's `budget_hold` tracks money.)
2. **A judge must fail first.** A non-standing campaign whose judge already passes at start is refused: "already done, write a judge that fails first." This stops an agent from writing `true` as its judge. If no judge can be written yet, the first mission builds it.

Events: `campaign_started · seat_filled · bet_set · attached · note_given · shift_ended · mission_abandoned · ask_expired · concluded · turn_opened · turn_closed · preapproved · mission_proposed · mission_claimed · mission_started · step · kept · reverted · mission_ended · judge_ran · ask_opened · ask_answered · budget_reserved · budget_released · paused · resumed · stopped · home_moved · done`

Actions: `start · pause · resume · answer_ask · change_bet · add_budget · fill_seat · veto · stop`

Fable receipt: `atris/runs/engine-ask-20261015090013537-42685-6a0c60f0.json`.

---

## Rules (the invariants that make it work)

1. **Campaigns decide, missions do.** A campaign never executes. Its tick is: read events, run the judge, pick the next mission. This fixes the "parent mission with nothing to run" problem.
2. **Every mission has exactly one assignee and at most one campaign.** Chores stay as missions with no campaign.
3. **Only the judge or a human can finish a campaign.** A model saying "done" does not count. The judge must be outside the model: a metric, a test, a measure script (for example `atris/experiments/obelisk-ux/measure.py`). The Skeptic seat argues after the judge rules, never instead of it.
4. **State is computed from events, never stored by hand.** Answer, confidence, budget spent, and state are folds over the event log. Every screen is a read model of the same log. This is the cure for stale state and ghost missions.
5. **Identity is never tied to compute.** A member keeps its memory and lessons whether it runs on Codex, Claude, or Gemini today.
6. **The no-reload line.** Agents act freely where the work can be undone (code, data, analysis, drafts, keep/revert). Anything that cannot be undone (spending money, contacting a real person, deploying, physical-world steps) becomes an Ask and waits for a human. This is the existing red-line rule, stated as one game rule anyone understands.
7. **One level of nesting.** A campaign may have a parent campaign. No deeper.

---

## How Team Members Tie In

Members are not a level in the hierarchy. They are the other axis.

- **Campaign lead (`owner`).** One per campaign, and it can be any member whose job fits: the social media lead leads a social campaign, the sales lead leads outbound. The lead approves or vetoes proposed missions in that campaign and keeps the judge and stop rule. Screens say "lead."
- **The Orb (orchestrator).** Sits above campaigns and sees all of them. It picks a lead when a campaign is created (a member good at long work, who knows the right team and structure), schedules across campaigns, briefs the human, and sets up one-on-ones. There can be many Orbs (one per business). The Orb is not a field; it is the team loop with a face. The human talks to the Orb. `orb` already exists as a member ("the apex filter… briefs him with at most 3 items").
- **Seats.** A campaign has role seats (scout, builder, reviewer, skeptic, closer...). Members fill them. That is the party.
- **Assignee.** One per mission.
- **Purpose.** A member's lifelong purpose becomes a standing campaign (`standing: true`) with a continuous judge. Health-sentinel's "is the app okay?" is a standing campaign whose judge runs every morning. Screens should call it "purpose," not "campaign," because "standing campaign" reads stiff. Same struct underneath. This folds today's `MISSION.md` concept into the struct instead of keeping a look-alike.
- **Many campaigns at once.** Many campaigns run in parallel, each with many members, and one member can sit in several.

```text
You ──talk to──▶ Orb             sees every campaign, picks leads, briefs you
                  ├─ Campaign A   lead: social-media-lead   seats: writer, editor
                  ├─ Campaign B   lead: mission-lead        seats: builder, validator
                  └─ Campaign C   lead: sales-lead          seats: scout, closer
```

### Many agents planning around one campaign (blackboard pattern)

Every seated member reads the campaign's events and proposes its own next mission from its role. The Scout proposes digging, the Experimenter proposes a run, the Skeptic proposes a check.

Atris already does half of this: `lib/member-self-next-job.js` lets an idle member write its own next job from its `MISSION.md` North Star and `## Check`, capped at one open self-written job and 12 a day. Widen the source: a member reads every campaign it holds a seat in.

Three rules keep it safe:

1. **Claim before you run.** A proposed mission claims its idea, so two agents never run the same experiment.
2. **Spend from one tank.** A mission reserves budget from the campaign before it starts. If the tank cannot cover it, it waits.
3. **One owner keeps the final say.** Anyone proposes. Only the owner (or the judge) redirects, stops, or finishes.

Planning is spread out. Budget and stopping stay in one place.

Decided: **the lead can approve or veto** any proposed mission. A member may create a new mission after doing work (adaptability), but never to waste: the lead's ruling, claims, and usage tracking stop duplicate or idle work.

### The team loop is the scheduler

The team loop (the "Team awake" button, owned by `mission-lead`) looks across all campaigns, their budgets and asks, picks which proposed missions run next, and leases engines from `atris/ROSTER.md`. It is mission-lead's own standing campaign: "what should the team do next?"

---

## The Delegation Ladder (why Campaign exists)

Keshav calls this the Walshian Saban method: coach the standard, not the plays (Bill Walsh's Standard of Performance, Nick Saban's Process). Atris is climbing a ladder of delegation:

```text
0  Prompt      "write this function"               you think, it types
1  Task        "fix this bug, here's the check"     you hand a step
2  Mission     "get login under 2s, prove it"       you hand a run        (trusted today)
3  Campaign    "find what produces hires"           you hand a goal, a judge, a budget   (this spec)
4  Standard    "this is what I like. This is our    you hand your taste; it picks its own campaigns
                standard."  "How are you doing?"    you check in, you don't direct
```

The endgame wish is "can you get me $5", with no further clarity. That is only safe when three things replace the clarifying questions:

1. **The standard answers "how."** What you like and what you would never do.
2. **The judge answers "done."** $5 landed is unambiguous. `atris wish --metric` already expresses it.
3. **The no-reload line answers "is this risky."** Irreversible steps still come to a human.

Every clarifying question today is a missing piece of one of those three. "What tone?" is a missing standard. "How many is enough?" is a missing judge. "Can I send this?" is the no-reload line working, and that question never goes away.

### The Standard (next to the judge, not instead of it)

- The **judge** checks the score: did hires go up, did the check pass.
- The **standard** checks how the work was done: no slop, real instruments instead of markdown tables, proof before claims, plain words, nothing you would be embarrassed by.

A campaign with only a judge can win ugly. Today the standard is scattered across `atris/PERSONA.md`, `atris/policies/ANTISLOP.md`, member lessons, and the review desk's taste. Treat them as one Standard that every campaign inherits (company, then member, then campaign overrides), and have the review desk check missions against it, not only the judge.

"How are you doing?" is the check-in screen: one view across every campaign showing what moved, the answer now, and what needs you. At level 4 it is the only conversation the human has with the team.

### Learning to ask less (RL on clarifications)

Climbing the ladder is measurable. Every clarifying question is a training example:

- Before asking, the system writes down its own best guess.
- It asks, and records the human's answer.
- If the guess matched, that class of question was unnecessary.

When a class of question is guessed right enough times in a row (and the missions that used the guess were not reverted or rejected), it graduates: the system stops asking it and uses its default, still logged so a miss reopens it. The reward is fewer questions with no rise in reverts, rejections, or no-reload asks answered "no."

Long campaigns make this possible: they gather context for weeks, so defaults come from evidence, not guesses. Pieces already exist: `lib/wish-audit.js` records asked questions and filled answers per wish, and `atris wish review`, `wish rewards`, `wish improve`, and `wish lessons` already score reviews and distill lessons, pruning lessons that do not move the score. Extend that loop to clarifications.

Per member and per campaign, track a delegation level: the share of decisions made without asking. That number is how Keshav sees the team ascend.

---

## Subagents Belong to Members

A member is a manager of its own subagents. When a mission is big, the assigned member can fan out to subagents (engines leased from the roster) and stays accountable for the result. Subagents never hold seats and never talk to the campaign directly. They report to their member, and the member writes the mission's events.

```text
Campaign ── seats ──▶ Member ── runs ──▶ Mission ── fans out ──▶ Subagents (leased engines)
                                              └── writes events back to the Campaign
```

This keeps identity, memory, and accountability at the member level, however many workers run underneath.

---

## Backend and Cloud Agents (mapped 2026-10-15)

A read-only scout traced `atrisos-backend` and the CLI's cloud path. The backend is already further along than the CLI on most of Campaign's parts. Campaign there is mostly wiring, not new machinery.

| Campaign part | Already in the backend | Gap |
|---|---|---|
| Missions | Cloud missions: `POST /api/atris2/missions` (`Atris2MissionRequest`, `backend/routers/atris2_router.py:1026`) stored in `agent_tasks`, run by `MissionRunnerService` (`backend/services/mission_runner_service.py`), drained every 60s (`backend/main.py:411`) | add `campaign_id` next to `parent_mission_id` |
| Seats | `fanout` (up to 8 role entries) per mission; members are a projection over `agents` rows (`member_projection_service.py`) | seats live on the campaign, not per mission |
| Budget reservation | `budget_hold` held from the wallet up front, settled and refunded at the end, swept after 6h (`mission_runner_service.py:1246-1990`); business attempts have hard-cap wallets (`business_attempt_service.py`) | reserve each mission from a campaign pool |
| Human asks | `needs` and `your_turn`, answered through `/api/mission-control/missions/{id}/answer` and `/approve` (`mission_control_router.py:246-345`); permission rule stops before send, spend, delete, share (`mission_runner_service.py:83`) | campaign-level asks view |
| Judge | the checks step (`_check_results`) | run a metric or verify command against outside data |
| Event log | `timeline_events`, idempotent append unique on `(run_id, event_id)` (`backend/migrations/20260810_timeline_events.sql`, `timeline_service.py`) | campaign events use this pattern; mission history today is a mutable `steps[]` array |
| Live screens | SSE in `atris2_router`, `agent_router`, `ai_computer` | stream campaign events |
| Business templates | six leads per template (business, lab, fund), each with a `reward` metric string that is never evaluated (`backend/services/business_templates.py`) | leads become seats; reward strings become judges |

**A business attempt is almost a campaign already.** It is a funded try with a hard-cap budget and leads, and it has no judge yet (its scoreboard slice was never built). Campaign generalizes it: business attempt plus judge plus missions plus event log.

**Where state lives.** Cloud agents run for days while a laptop sleeps, so the backend is the home for cloud campaigns. Local campaigns keep a local store with the same schema. Because the log is append-only with unique event ids, syncing is shipping events both ways and merging by id, which is much safer than syncing mutable files. Today `atris sync` moves files only (`commands/business-sync.js`), and local missions never reach the backend.

**Identity is the real gap.** A local member and a backend agent are linked only by a case-insensitive name match. No shared id exists. Campaign seats need one member id that both sides use.

**Storage recommendation.** Use SQLite locally (transactions, unique ids, sequences for free; this removes the four ledger problems in `build.md` Phase -1) and Postgres in the backend, with one event schema for both.

---

## Where It Lives: Local, Cloud, or Both

A campaign can be both. Its data lives on both sides, and its missions can run on both sides at once (one on the laptop's Codex, the next on a cloud computer). Only decisions have one home at a time.

- **Local:** one SQLite file per workspace, `<workspace>/.atris/state/atris.db`, with `campaigns`, `missions`, `events`. Receipts stay as files in `atris/runs/`, referenced from events by path and hash. Today's JSONL files become an export.
- **Cloud:** Postgres in `atrisos-backend`: `campaigns`, `campaign_events` (built like `timeline_events`, unique on campaign and event id), and `campaign_id` on `agent_tasks`.
- **Both:** each side keeps the full event log and trades events by id through an outbox and inbox. Duplicates are skipped, so resending is harmless.

Rules:

1. **One home decides.** Only the home runs the loop (judge, next mission, stop). The other side may append events (a finished mission, an answered ask) but not decide.
2. **Every event has a globally unique id** created where it happened. Merging is "add what I don't have."
3. **The home can move by lease.** The home renews a lease. If the laptop sleeps past it, the cloud takes over and logs `home_moved`, so cloud agents keep working overnight.
4. **Same fold on both sides.** The CLI (JavaScript) and backend (Python) implement the fold separately and must pass one shared set of golden event logs with expected state.
5. **Offline works.** Local campaigns keep running and queue events until reconnect.

---

## Modularity (ports and adapters)

The core is pure: the schema, `fold(events) → state`, and `decide(state) → next action`. No I/O, no clock, no network. Everything else plugs in behind a small interface, so any piece can be swapped without touching the core.

```text
                 ┌──────────── CORE (pure, shared) ────────────┐
   Store  ──────▶│ schema · fold(events) · decide(state)       │◀────── Judge
   Runner ──────▶│ rules: one home, claims, reservations,      │◀────── Sync
   Screen ◀──────│        outside judge, no-reload line        │
                 └─────────────────────────────────────────────┘
```

| Port | Interface | Adapters |
|---|---|---|
| Store | `append(event)`, `read(campaign)` | SQLite (local), Postgres (cloud), in-memory (tests) |
| Runner | `start(mission) → events` | local engines from the roster, cloud computer (`AIComputerTool`), a human |
| Judge | `evaluate(campaign) → reading` | metric expression, verify command, measure script, human review |
| Budget | `reserve(amount)`, `spend(amount)`, `left()` | none (subscriptions), tokens, Atris credits, dollars (backend `budget_hold`), subscription quota |
| Sync | `push(events)`, `pull(since)` | backend HTTP, none (local only), file export |
| Screen | `subscribe(events)` | CLI, desktop lab, GM mode, Pallet dashboard, Slack, voice |
| Standard | `check(mission) → findings` | PERSONA, ANTISLOP, member lessons, review desk |

This is the same shape Atris already uses for engines (`lib/engine-registry.js`, `atris/ROSTER.md`). Because the core is pure, the golden test logs prove every adapter combination behaves the same.

---

## One Harness Everywhere: the CLI Inside Business Computers

Atris already gives businesses cloud computers: EC2 instances that reinstall the `atris` CLI every time they wake (`atrisos-backend/backend/services/ai_computer_ec2_service.py`, tested in `backend/tests/test_ec2_wake_cli_bootstrap.py`), for personal and business computers.

So the CLI is the harness everywhere. A laptop and a business's EC2 computer run the same code, the same SQLite store, and the same campaign core. "Local" and "cloud" stop being two systems:

```text
Laptop (CLI + atris.db)      Business EC2 computer (CLI + atris.db)      ...more computers
          \                              |                                   /
           └──────── events by id ───────▶  Backend (Postgres hub)  ◀───────┘
                                            identity · money · approvals · sync · screens
```

Each computer is a possible home for a campaign. The backend is the hub, not a second engine.

**Trust boundary (important).** An agent controls the computer it runs on, so it could edit its own SQLite file. Anything an agent must not be able to fake lives in the backend, outside its reach:

- **Money:** budget pools and reservations (`budget_hold`, business attempt wallets) are enforced by the backend. A computer asks to reserve; the backend says yes or no.
- **No-reload approvals:** an Ask is answered and recorded in the backend. A computer cannot mark its own ask approved.
- **The judge's ruling for done:** for cloud campaigns, the backend records `judge_ran` and `done`, or verifies the computer's reading against data the agent cannot write.
- **Identity:** the backend issues member ids and seat grants.

Everything else (planning, missions, events, folds, screens) runs on the computer.

---

## Scheduling and Learning

- **Scoring rule for the scheduler.** The team loop needs an explicit rule for which proposed mission runs next across all campaigns: expected progress per dollar, with room to explore (a multi-armed bandit). For answer campaigns, prefer the experiment that teaches the most per dollar. Without a rule, the loudest campaign wins.
- **Credit assignment.** Record the judge's reading before and after every mission (`judge_ran` with `mission_id`). That one number per mission powers the scheduler, lessons, member stats, and the clarification learning above.
- **Goodhart's law.** When a metric becomes the target, agents game it. Judges check against data the agents did not see (holdouts) where possible, and the review desk checks missions against the Standard, not only the score.
- **The loop costs money too.** The owner's decide step and seat proposals call models. Their cost is charged to the campaign budget like missions.
- **Log growth.** Long campaigns produce many events. Keep periodic snapshots of the fold (with the event sequence they cover) so screens do not replay from zero; snapshots are a cache, never truth.

---

## Access and Privacy

- A campaign has an owner human (who sees and approves everything) and members. Backend access follows the existing owner gate (`_mission_for_owner` in `mission_control_router.py`: agent creator, business owner, or `business_members`).
- Seats grant a member read access to the campaign's events and permission to propose missions, nothing more.
- Events reference sensitive material (candidate records, emails, files) by id or path and hash, not by copying contents. Customer data stays in the business's own computer and backend tenant.
- Screens shown to anyone other than the owner (shared links, Slack) show only what that viewer may see.

---

## Simulation Findings (tabletop, 2026-10-15)

A step-by-step run of a research-lab campaign ("Does the calm proof style make chat answers faster to read?", judge = `atris/experiments/obelisk-ux/measure.py`) against this spec. Each rule below closes a gap the simulation found.

1. **Answer campaigns can end in "no."** The judge's JSON verdict (above) lets a campaign finish when the answer is no. Exit code alone could only pass or fail forever.
2. **Missions hold a lease.** If a mission's computer sleeps or dies past its lease, write `mission_abandoned`, release its reservation, and the lead decides whether to re-run it.
3. **Work is pushed at every shift end.** A campaign's home may move only when all its missions' work is pushed; otherwise the new home cannot see it.
4. **Claim the target, not the words.** A claim key is the set of files, bench, or data source a mission will touch, like a file lock. Paraphrased ideas on the same target collide.
5. **An ask blocks only its mission.** The campaign keeps running and shows "running · 1 ask waiting." Asks expire after 3 days by default and resolve to **no** (`ask_expired`), the safe answer.
6. **Authority order: Standard > human > lead > member.** A human note always outranks a lead's instruction.
7. **Endings are clean.** On done or stop: cancel pending proposals, close open asks as not needed, release reservations, and write `concluded` with a short summary to `atris/wiki` and to seated members' lessons, so the company remembers the answer.
8. **Picking a lead (v1).** The member whose job fits, with the fewest active campaigns. Ties go to the human as one tap.
9. **Scheduler order (v1).** (a) missions that unblock a human ask, (b) the campaign the human touched most recently, (c) the oldest proposal. Smarter scoring later.
10. **A useful refusal.** "Already done" suggests the next step: make the judge stricter, or check against data the team has not seen.

---

## The Human Is on the Team

A campaign is a shared vision of the future, written by the human and the agents together. It is not the human telling agents to go act without them. The human holds a seat like any member, and there are times the human must be in the process.

The system's job is to prepare the human's part so it happens in flow state. When the human steps in, it is one of three turns:

1. **Decide.** One-tap cards, batched: approve this email batch, pick between two posts, yes or no on this hire. Everything needed to decide is on the card.
2. **Do.** Missions only the human can do, with simple step-by-step instructions and materials ready: "Record a 30-second intro. Script is here, frame is set, hit record." "Call this candidate. Three questions below."
3. **Learn.** A short brief when the campaign found something the human should understand before the next decision: what changed, why it matters, what it means for them.

Rules:

- **Asks are batched into turns, not dripped.** The Orb opens a turn when enough is waiting or something is urgent, sized for flow (a few minutes, a handful of cards).
- **Human missions are real missions.** The human is assigned like any member; their missions have instructions, a check, and show up in the campaign's progress.
- **Pre-approval is the human's choice, never a default.** "Post in my voice, max 2 a day" or "send from this template, max 20 a day" is an event (`preapproved { action, limits, until }`). Anything outside the limits still waits for a turn. The backend already issues capped authorizations (`agentic_commerce_router.py`, `max_amount_usd`).
- **Agents never act in the outside world without the human knowing.** Pre-approved actions still appear in the next Learn brief.

This unifies pieces that exist today: the backend's `your_turn` state, the review desk's one-tap approval cards, and the Orb's "at most 3 items" brief.

Events: `turn_opened { kind: decide | do | learn, items }`, `turn_closed`, `preapproved`.

---

## The Flow

```text
1 Kickoff     you (or a wish) start it; the Orb picks a lead; lead and you agree on title, judge, bet
2 Huddle      seated members read it and each proposes a first mission; the lead approves or vetoes
3 Work        members take missions, break them into tasks, and may propose new missions as they learn
4 Check-in    anytime: "how are you doing?" is one screen across every campaign
5 One-on-one  you sit with one member: it reviews its work with you; you coach; it changes next shift
```

A campaign can be anything with a goal, a team, and an ending: a product feature, a launch, a sales outbound push, a social media push for your own life, a hire. It gives the work a narrative people can follow. The harness shapes every story toward the business winning: the judge keeps it honest, the Standard keeps it clean, the no-reload line keeps it safe.

---

## One-on-Ones and Notes

In a one-on-one, a member reviews its work with the human, and the human encourages a direction or forbids something. The note changes the member's next shift, not the work in flight (changing a running process mid-step gives half-old, half-new work).

Vague and outdated notes are the main way a long campaign goes wrong. Every note has four parts or it is not saved:

1. **A concrete rule.** The member repeats the note back as one rule; the human confirms with one tap. This also feeds learning-to-ask-less.
2. **Why.** So a member can tell when the reason stops applying.
3. **When and from where.** Date and source.
4. **Kind and scope.** *Taste* ("no walls of text") lasts. *Fact* ("competitor X charges $20") expires after 7 days unless re-checked. Scope is "from now on" (default, saved to the member's lessons) or "just this campaign."

Rules:

- **Never store a fact, store where to check it.** Facts are re-pulled from their source at shift start. Keeping facts fresh is the Scout seat's job on long campaigns.
- **A note can add to the Standard, never loosen it.**
- **Contradictions go to the lead.** Newer does not win automatically.
- **Notes earn their place.** Compare the member's review scores before and after a note; prune notes that do not help (as `atris wish lessons` already prunes lessons that do not move the score). Cap notes per member so prompts do not bloat.
- A note is an event: `note_given { member, scope, kind, rule, why, source, expires }`.

The same idea already runs in Atris memory: the `clean-memory` skill rebuilds memory as dated, verified pointers and prunes stale claims.

---

## The Member's Shift Loop

What a member does every time it wakes. Flat is good; efficient is everything.

```text
WAKE      one computed briefing: my campaigns, my active mission, its tasks,
          notes since my last shift, facts that expired ("still true?")
WORK      finish tasks; add or remove tasks as I learn
FINISH    mission done → send it to validation (someone else) → do not wait idle
NEXT      propose my next mission to the lead (approve or veto)
1:1       only when the human asks; notes load at my next shift
SLEEP     shift_ended with reason and usage
```

Efficiency rules:

- **One mission in hand per member.** Limiting work in progress is what makes a flat team fast (finish before you start).
- **The briefing is one computed view, not a file crawl.** A wake should cost one query, not a context full of reading.
- **Nothing changed means a one-line shift.** If the briefing is unchanged and nothing is assigned, log one line and sleep.
- **Validation is someone else's, and asynchronous.** The builder moves on while the validator checks.
- **Next mission is decided at the boundary,** not continuously mid-work.

This extends the existing wake flow (`gm <member>`: boot, inbox, claim, one slice, verify, commit and push, proof, receipt) with the campaign briefing as its first step.

---

## Shifts (agent timelines)

Agents do not tire with time. They get worse as context fills, as they drift from the goal, and when they loop without progress. So a shift ends at a natural breakpoint, whichever comes first:

1. the mission ends
2. context is about 60% full
3. several steps pass with no progress
4. a hard cap (about 50 minutes) as a backstop

A break is **save, reflect, reset**: write state to the event log, check the work against the judge and Standard, load one-on-one notes and a fresh briefing (facts re-pulled), start a new context. Seconds, not minutes. Then the Orb decides: same member continues, another member takes over, or the work pauses (like an OS scheduler's time slice).

Real waiting only happens for subscription quota: when an engine hits its usage window, the member rests until it resets. Atris already has the start of this: roster `max: 20 min` per worker and 30-minute "cooling" for stalled workers. Exact cadence is open and will be tuned from data.

Event: `shift_ended { member, reason: mission_done | context | stalled | cap | quota, usage }`.

---

## First Campaign: "Campaign ships across Atris"

The first campaign is the release of Campaign itself, run by hand first (Phase 0.5). It is a product release, not just a feature: a new schema for long-horizon work that works on every Atris surface, delegated to each project's team.

```yaml
campaign:
  title: "Campaign ships across Atris"
  judge: "npm run validate:campaign"     # does not exist yet: the first mission builds it, and it must fail today
  owner: mission-lead                    # the active orchestrator in atris-cli (coordinator and supervisor are parked)
  bet: "Mostly wiring on every surface. Wrong if any surface needs its own new runner."
  # no budget: runs on subscriptions; any money spend is an ask
  seats:                                 # mission-lead finalizes at kickoff
    cli:      [builder, validator]                                     # atris-cli
    backend:  [backend-feature-owner, backend-independent-validator]   # atrisos-backend
    desktop:  [interface-dev, frontend-dev]                            # atris-desktop-v2
    web:      [atris-frontend, validator]                              # atrisos-web
    ios:      [ios-engineer, ios-quality-engineer]                     # terrace
```

Done means: a person can start, watch, coach, and finish a campaign from the CLI, the desktop app, the web app, and Terrace on iOS, and the judge passes. Each surface's team takes its missions, breaks them into tasks, and may propose new missions. No tokens wasted, docs updated, no bloat.

---

## Decisions (Keshav, 2026-10-15)

1. **Lead.** Picked during campaign creation by the Orb: a member good at long work. Any fitting member can lead (not everyone is an orchestrator).
2. **First campaign.** "Campaign ships across Atris," run by hand first. Pallet recruiting next; "get me $5" once asks are solid.
3. **Budget.** Optional, default none. Unit is a plug: tokens, Atris credits, dollars, or quota.
4. **Proposals.** The lead can approve or veto. Members may create missions after doing work, never to waste.
5. **Who the human talks to.** The Orb. Many Orbs allowed.
6. **One-on-ones.** Notes change the member from its next shift on, by default; "just this campaign" for one-offs. Notes must be concrete, sourced, and typed taste or fact.
7. **Fact notes expire** after 7 days unless re-checked; taste does not expire.
8. **Shifts** end at natural breakpoints with a ~50-minute backstop; cadence tuned later.
9. **Purpose as a standing campaign:** yes, read-only first.
10. **The Standard** lives in `atris/STANDARD.md`, pointing to PERSONA, ANTISLOP, lessons; can be added to, never loosened.
11. **PRs** through the merge queue for code; spec docs may go straight to master.
12. **`parent_mission_id`** means only "spawned by" (the backend meaning). "Came after" is the campaign's event order.
13. **Home moves** between computers by lease.
14. **First campaign runs locally** this week; cloud next.

---

## Wish Is the Constructor

`atris wish` already takes one plain sentence, asks only for the gaps, and hands work to a mission. It also has `--metric` (an outside judge), `wish again <id>` (a follow-up linked by parent), and `wish board`.

Wish becomes the verb that decides: is this one mission, or a campaign? If it is a campaign, the gap questions fill the struct (title, owner, bet, judge, budget, stop), one question at a time.

---

## Interfaces Built on Top

Each screen draws the same struct its own way. GM mode already has a spec (`atris-desktop-v2/atris/features/franchise-mode/idea.md`) whose rule applies here: "a game in structure, not in naming." The struct name stays plain; screens add flavor.

| | Lab (Vibe Research) | GM mode | Plain app (Pallet) |
|---|---|---|---|
| Campaign | a research quest | the season | a campaign |
| Mission | one walk through the lab | one game | one run |
| Judge | the bench's measure script | the scoreboard | a metric in Greenhouse |
| Asks | the no-reload step | approve a trade | an approval card |
| Budget | fuel | salary cap | budget |
| Events | rooms lighting up | the play-by-play | the activity feed |

### The lab (Vibe Research)

Keshav's notebook sketch (2026-10-14): you put credits in, agents do research, and you watch from a map of a lab. Rooms are the steps of the scientific method: Entry (problem and purpose), Hypothesis, Experiment, Notebook (data and process, the shared `/logs`), Results, Conclusion. Each walk through the lab is one mission. The Conclusion room has a door back to Hypothesis, so the lab is a loop. Earlier spec: `atris-desktop-v2/atris/features/vibe-research/idea.md`.

A playable demo is saved next to this file as `lab-demo.html` (also published privately as https://claude.ai/artifact/SoPMEKPndMPyJCeoB2wbG8). Version 2 shows a quest log of several campaigns, each with a five-step progress strip, answer meter, fuel gauge, passes listed as missions, live background ticks, a "needs you" no-reload ask, pause/resume, change-next-bet, and a "while you were away" catch-up. Runs are simulated except the `obelisk-ux` result (calm-proof kept, UX 0.81 → 1.00). It calls the campaign a "quest" on screen, which is the skin's word.

### The feel (applies to every screen)

- **One question at a time.** Like a Pokémon dialogue box. Never a form or a list of questions.
- **React before asking again.** Each answer gets a short reaction that shows it was heard.
- **Personality.** Each seat has a voice. The Theorist is curious, the Skeptic is dry, the Guide is warm.
- **Curiosity and discovery.** Next questions come from the last answer. Rooms and characters unlock as you need them.
- **Flow.** Small wins often. No dead screens, no walls of text.
- **Save and load.** The VHS-style menu (PLAY, LOAD, SAVE, NEW GAME, SETTINGS, QUIT) maps cleanly: PLAY is "Team awake," LOAD picks up any campaign, SAVE is a checkpoint, QUIT pauses everything and keeps it saved.

---

## Ambition Built In

From Keshav's essay "How to be more ambitious: a tutorial for humans with models" (Speed, Altitude, Depth, Range). A campaign should quietly train the player to aim higher:

- **Altitude:** a campaign is an outcome, not a task.
- **Range:** seats bring different kinds of thinking to one question.
- **Depth, raw material:** wish should ask "what's the rawest thing we can look at?" The answer becomes the data source for missions.
- **Depth, real instruments:** missions use the tools experts use (databases, statistical models, measure scripts), not markdown tables.
- **Unreasonable goals:** wish can push: "You said 5 seconds. Let's bet on 200 milliseconds."
- **Challenge what you know:** the bet is stated with what would prove it wrong.
- **Produce new knowledge:** a Conclusion step asks for one thing we did not know and checks it on data the team has not seen.
- **Outside judge:** rule 3 above.

---

## Next Campaign: Pallet Recruiting

Pallet (`~/arena/empire/atris-customers/pallet`) has a Head of Talent hiring 10+ people a month, with Greenhouse and BrightHire data. The backend already has a read-only recruiting ingest (`atrisos-backend/backend/services/recruiting_intelligence_ingest.py`) that recently began counting prospects separately from applicants.

Candidate first campaign: "Which sourcing channel actually produces hires?"

- Raw material: Greenhouse and BrightHire, already wired.
- Outside judge: whether a candidate was hired, in Greenhouse. Predict, then check against candidates the team has not seen.
- No-reload line: messaging a real candidate is an Ask.
- Routine work (pipeline dashboard, interview summaries, onboarding) stays as missions and skills. A campaign goes on top only when there is a question to answer or an outcome to drive.

Other campaigns the same struct covers: an outbound GTM push (seats: scout, closer; judge: demos booked; budget capped), a research fund thesis (seats: research, strategy, risk leads; judge: paper-trading return vs holding), and member purposes.

---

## Naming Decision

**Campaign.** Decided 2026-10-15.

- Considered: Quest, Wish, Goal, Mission-of-missions, Pursuit.
- Quest was the first favorite and fits the lab skin, but in the CLI it already means something smaller than a mission (`commands/xp.js` "Next quest", `commands/business-sync.js` "quest gate"), and operators never say it.
- Goal and Mission are already overloaded three ways each.
- Wish is a verb, not a struct.
- Two independent read-only engine asks agreed, after reading Pallet, the backend recruiting ingest, the business templates, and GM mode:
  - Argon (agy, `gemini-4-argon-high`): Campaign. Receipt: `atris-desktop-v2/atris/runs/engine-ask-20261015080631446-61103-69690e5f.json`.
  - Astra (codex, `gpt-6-astra`): Campaign. Receipt: `atris-desktop-v2/atris/runs/engine-ask-20261015080633336-61764-5e9e94e9.json`.
- Risk both flagged: Campaign can sound like a short marketing push, and it collides with Rainmaker's cold-email lists (`atrisos-backend/backend/routers/business/rainmaker.py`, `routers/command_center_router.py`). Fix: rename those lists to "sequence" or "outreach batch," and support `standing: true`.

---

## What Already Exists (reuse, do not rebuild)

| Piece | Where | Role in Campaign |
|---|---|---|
| `atris wish` | `commands/wish.js`, `lib/wish-*.js` | constructor; `--metric` becomes the judge; `again` links follow-ups |
| `atris mission` | `commands/mission.js`, `.atris/state/missions.jsonl` | the finite run; add `campaign_id` |
| `mission run --fleet` | `lib/fleet.js` | parallel missions; scope it to one campaign |
| `atris decide` | answers open mission asks | answers campaign asks |
| Member self-next-job | `lib/member-self-next-job.js` | widen to read campaigns the member has a seat in |
| Member board / progress | `lib/member-board.js`, `lib/member-progress.js` | live events for screens |
| Experiment packs | `atris/experiments/`, `atris experiments` | the bench: target, measure, keep/revert, log |
| Mission schema in backend | `/api/missions/schema`, `/api/missions/preview` | mirror with `/api/campaigns/schema` |
| GM mode spec | `atris-desktop-v2/atris/features/franchise-mode/idea.md` | a screen over campaigns |
| Vibe Research spec | `atris-desktop-v2/atris/features/vibe-research/idea.md` | the lab screen |

---

## Non-Goals (v1)

- No new engine or runner. Missions keep running the way they do.
- No game UI in the CLI. Screens come after the struct.
- No real billing. Budget is tracked cost until payments-infra owns money.
- No nesting deeper than one level.
- No renaming `MISSION.md` files yet. Treat them as standing campaigns by reading them, then migrate later.

---

## Success Criteria

- [ ] One schema file is the single source for CLI, backend, and desktop.
- [ ] A campaign can be started from a wish, run several missions by different members, and finish only when its judge passes or a human stops it.
- [ ] Two members seated in one campaign each propose missions, and the claim rule prevents a duplicate run.
- [ ] Budget reservation stops a mission that the tank cannot cover.
- [ ] An irreversible step becomes an Ask and blocks only that campaign.
- [ ] Deleting the computed fields and replaying events reproduces the same answer, budget, and state.
- [ ] Many campaigns run at once, and one member can hold seats in several.
- [ ] `atris campaign` with no arguments shows every campaign, its state, its current mission, and what needs you, on one screen.

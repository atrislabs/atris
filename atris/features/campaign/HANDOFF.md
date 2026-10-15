# Campaign — Handoff

> Start here. Read this file, then `first-campaign.md`, then the parts of `idea.md` and `build.md` your mission needs. Do not read everything up front.

## What it is (one paragraph)

Campaign is the struct for long-horizon agent work. A wish starts it. A campaign lasts, has one lead and many seated members, and never runs code: it reads events, runs its judge, and picks the next mission. Missions (one member, one run) do the work and break into tasks. Only the judge or a human finishes a campaign. The human talks to the Orb, which sees every campaign, picks leads, and briefs.

```text
Wish → Campaign (lasts) → Mission (ends) → Task
Orb (above campaigns) · Lead (one per campaign) · Seats (members) · Judge (one command)
```

## The struct (write only this)

```yaml
campaign:
  title: "..."          # required
  judge: "<command>"    # required; exit 0 = pass; must fail at start (unless standing)
  owner: <member>       # optional lead; the Orb picks one if left out
  seats: [..]           # optional
  bet: "..."            # optional; hypothesis + what proves it wrong
  budget: { amount, unit }   # optional; tokens | credits | dollars | quota; none = subscriptions
  standing: false       # optional; true = a purpose that never ends
```

Everything else is computed from events. Never store a computed value.

## Rules you must not break

1. Judge = one runnable command. No campaign without one; if you cannot write it, your first mission builds it.
2. Events are append-only with a unique id and sequence. State is a fold over events.
3. Every mission reports usage (tokens, quota, money if any) when it ends.
4. Anything that cannot be undone (money, messaging a real person, deploy) is an ask. Wait. Asks are batched into the human's turn (decide, do, learn), never dripped. The human is a seat on the team, not an approver at the edge. See idea.md → The Human Is on the Team.
5. One home decides. Other computers only append events.
6. The core is pure. Store, runner, judge, budget, sync, and screens are adapters.
7. Notes from one-on-ones are concrete, sourced, typed taste or fact, and load at the next shift. Fact notes expire in 7 days.
8. No bloat: do not add fields, files, or steps the spec does not ask for. Ask first.
9. Read idea.md → Simulation Findings before writing events, claims, asks, or the judge. It closes ten gaps found in a tabletop run.

## Where things are

| You need | Read |
|---|---|
| The first campaign and its seats | `first-campaign.md` |
| Your phase and its check | `build.md` (Phase -1 through 11, plus 9.5) |
| Proof of done | `validate.md` (16 checks) |
| Why a design choice was made | `idea.md` → Decisions, Rules, Naming Decision |
| Backend pieces to reuse | `idea.md` → Backend and Cloud Agents |
| The playable lab demo | `lab-demo.html` |

## How to work

- Each wake: read your campaign briefing, hold one mission at a time, finish tasks, send the mission to validation, propose your next mission at the boundary. See idea.md → The Member's Shift Loop.

- Take one mission. Put `campaign:cmp-campaign` in its objective. Break it into tasks in your repo's task system.
- Before code: `git status`, fetch the default branch, work in a worktree or branch, stage only your files.
- Code goes through a PR and the merge queue so `test` runs. Spec docs may go straight to master.
- When done: run your phase's check, write the receipt path into the event log in `first-campaign.md`, and move your task to review with proof. The validator reviews, never the builder.
- If you learn something that changes the plan, propose a new mission in the event log. The lead approves or vetoes.
- Update docs you touched in the same PR. Delete what is stale.

## Stop and ask Keshav before

- changing how missions behave when no campaign is involved
- renaming `MISSION.md` files or changing `parent_mission_id`
- spending money or messaging a real person
- adding a field to the struct

## Receipts behind the decisions

- Naming (Argon, Astra): `atris-desktop-v2/atris/runs/engine-ask-20261015080631446-61103-69690e5f.json`, `engine-ask-20261015080633336-61764-5e9e94e9.json`
- Storage review (Astra): `atris-desktop-v2/atris/runs/engine-ask-20261015082757758-9544-5527bb9c.json`
- Final struct (Fable): `atris-cli/atris/runs/engine-ask-20261015090013537-42685-6a0c60f0.json`
- Argon final review: pending; Keshav will paste it in.

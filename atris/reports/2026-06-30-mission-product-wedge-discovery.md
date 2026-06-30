# Mission Product Wedge Discovery

Date: 2026-06-30
Mission: mission-2026-06-29-discover-the-atris-product-w-3ef1265b
Task: CLI-555
Owner: mission-lead

## Source Facts

- Runway pressure is real, but tonight's product decision cannot depend on DoorDash collection.
- DoorDash has a PO, but DoorDash is not tonight's wedge.
- Warm buyer mission rooms often waste cycles when they become founder sales theater.
- The target is product-led growth, not a services motion.
- The product aspiration is Atris Mission as the execution endgame: not slop, not a dashboard, not generic agents.
- The real question is still open: what do we want Atris to be first?

## Decision

Winner: Chaos -> Mission Room.

Product sentence:

```text
Paste the messy thing you are carrying.
Atris turns it into a named mission, chooses the first bounded proof step,
and emits a shareable receipt in under five minutes.
```

This is the first wedge because it starts from the user's actual state: stress, ambiguity, too many possible moves, and no reliable proof loop. It sells immediate relief and momentum. It also creates the artifact that spreads: the mission receipt.

The product is not "AI agents." The product is a living mission room that turns intention into proof.

## Scoring Rule

Each candidate is scored 1-5 on six dimensions:

- Relief: the user feels the pain disappear or sharpen immediately.
- Proof: the output can be checked, replayed, or accepted.
- Shareability: the output naturally invites another person or agent.
- Time-to-wow: the first useful moment happens inside five minutes.
- Recurrence: the same user would run it again this week.
- PLG loop: the artifact itself creates the next invite, handoff, or return.

Minimum viable wedge: 24/30, with Relief and Time-to-wow both at least 5.

## Five Candidate Outcomes

| Candidate | Promise | Relief | Proof | Shareability | Time-to-wow | Recurrence | PLG loop | Total | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Chaos -> Mission Room | Turn messy thought into named mission, first proof step, and receipt | 5 | 5 | 5 | 5 | 5 | 5 | 30 | Winner |
| Idea -> Buildable Mission | Turn a rough product idea into tasks, owner, verifier, and launch path | 4 | 5 | 4 | 5 | 4 | 4 | 26 | Strong second |
| Daily Operating Room | Start the day with one mission, one proof target, and one stop-doing list | 4 | 4 | 3 | 4 | 5 | 3 | 23 | Useful, but later |
| AgentXP Proof Gate | Review completed agent work and award XP only after proof | 3 | 5 | 3 | 4 | 4 | 3 | 22 | Important infrastructure, not wedge |
| Warm Buyer Close Room | Turn relationship context into outbound asks and follow-up tasks | 3 | 3 | 2 | 3 | 3 | 2 | 16 | Reject tonight |

## Why The Winner Wins

Chaos -> Mission Room is the only candidate that begins before the user knows what they want. That matters because the current user state is not "I need a dashboard." It is "I am carrying too much ambiguity and need the system to find the first true move."

It also creates a clean product-led loop:

```text
messy input
  -> named mission
  -> first bounded proof step
  -> receipt
  -> share/invite/claim
  -> next mission
```

The receipt is the growth surface. It can be sent to a collaborator, investor, teammate, customer, or agent. The recipient does not need a pitch; they can inspect the mission, proof, and next action.

## First Mission Spec

Name: Atris Mission Room

Trigger:

```text
I do not know what to do, but this has to become real.
```

Input:

- one messy paragraph, transcript, screenshot, task list, or repo state
- optional constraint such as runway, deadline, customer, product risk, or personal capacity

Output in under five minutes:

1. Mission name
2. Truth snapshot
3. Target outcome
4. Stop-doing list
5. First bounded proof step
6. Verifier or proof standard
7. Shareable receipt
8. Next invite or handoff

The first screen should not be a landing page. It should be the room itself: a mission card, proof lane, current step, receipt, and invite action.

## Activation Copy

Primary action:

```text
Run Mission
```

Empty state:

```text
Paste the thing in your head.
Atris will name the mission, pick the first proof step, and start the room.
```

Receipt share line:

```text
This mission moved from chaos to proof. Inspect the receipt or claim the next step.
```

## Product-Led Growth Loop

The shareable receipt must include:

- mission name
- original pressure or context, summarized without leaking secrets
- decision made
- proof step completed or ready
- verifier command, screenshot, receipt path, or accept gate
- next step
- invite action: claim step, review proof, or start a linked mission

The receipt should make Atris legible in one glance:

```text
Atris took messy intent and produced proof-backed motion.
```

## Tonight's Product Path

1. Dogfood with the live runway/product uncertainty as the first sample mission.
2. Produce three mission receipts from real messy inputs, not fake personas.
3. Measure time from paste to useful mission card.
4. Keep only controls that help the user decide, act, verify, or share.
5. Do not build more chrome until the five-minute mission loop feels obvious.

Pass condition:

```text
A user pastes ambiguity and, within five minutes, sees the mission they wanted but could not name.
```

## Eliminate

- Do not make DoorDash collection the product wedge.
- Do not make warm buyer outbound the wedge tonight.
- Do not ship generic AI agent positioning.
- Do not add dashboards before the mission card works.
- Do not let the room loop forever without a proof step.
- Do not call strategy complete unless there is a receipt someone can inspect.

## Next Build Bet

Build the smallest possible "Run Mission" experience:

```text
paste messy input
  -> generate mission card
  -> create first task
  -> run or define verifier
  -> emit receipt
  -> share/invite next actor
```

If this feels magical, the rest of Atris can compound around it: tasks, agents, XP, missions, receipts, business workspaces, and memory. If it does not feel magical, more infrastructure will not save the product.

## Verifier Contract

Run:

```bash
node scripts/verify-mission-product-wedge.js
```

The verifier proves this report names five candidate outcomes, scores them, picks Chaos -> Mission Room, rejects DoorDash and warm buyer as tonight's wedge, defines the five-minute output, names the shareable receipt loop, and includes the next build bet.

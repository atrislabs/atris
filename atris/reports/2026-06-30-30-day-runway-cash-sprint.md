# 30-Day Runway Cash Sprint

Date: 2026-06-30
Mission: mission-2026-06-29-30-day-runway-cash-sprint-tu-26d7ed54
Task: CLI-554
Owner: mission-lead

## Source Facts

- Runway is 30 days as of June 30, 2026.
- A DoorDash PO exists.
- DoorDash revenue is not invoiced yet.
- Cash motion must start tomorrow, July 1, 2026.
- Product mission remains: Atris mission run should become the endgame execution loop, not a side tool.

## Horizon

By July 30, 2026, Atris has converted the DoorDash PO into an invoice/payment path, created at least one additional fast-cash paid pilot or prepaid customer motion, and runs every day from a cash command loop: invoice, collect, close, ship proof, repeat.

The business does not survive this sprint by adding generic product scope. It survives by turning proof-backed Atris work into cash receipts and signed commitments fast enough that the 30-day runway becomes operating room.

## Reverse Path

```text
cash room by July 30
  <- cash collected or payment date confirmed from DoorDash
  <- invoice packet accepted by AP/procurement
  <- buyer/champion confirms PO, line items, terms, and payment owner
  <- 7-day paid pilot offer sent to warm prospects with invoice-first terms
  <- daily command loop ranks work by cash probability, not novelty
  <- non-cash custom work is eliminated unless tied to invoice, PO, or buyer proof
  <- July 1 cash day executes invoice packet + AP escalation + 10 warm close messages
```

## July 1, 2026 Cash Day

1. Build the DoorDash invoice packet before any product work:
   - PO number
   - buyer/champion contact
   - AP/procurement contact
   - legal vendor name
   - W-9 if needed
   - ACH/remittance details
   - invoice PDF
   - line item matching the PO language
   - payment terms and requested payment date

2. Send the DoorDash packet to AP and champion in the same thread:
   - ask them to confirm the invoice was received
   - ask who owns payment approval
   - ask the earliest payable date
   - ask whether anything blocks processing today

3. If AP cannot move fast, ask the champion for the fastest acceptable path:
   - partial upfront payment
   - milestone invoice
   - card payment
   - expedited vendor onboarding
   - written payment-date confirmation

4. Create the 7-day cash list:
   - 10 warm buyers, operators, founders, investors, or teams who already understand the pain
   - one paid pilot offer
   - one price
   - one proof artifact
   - invoice-first terms

5. Send 10 direct founder notes before the end of July 1:
   - no demo theater
   - one pain
   - one outcome
   - one proof
   - one price
   - one close question

## Offer

Fast-cash offer:

```text
Atris 7-day mission room

We turn one messy operating loop into a proof-backed AI mission system:
task truth, receipts, daily agent work, and a human accept gate.

Price: paid upfront or invoice accepted before build.
Delivery: 7 days.
Exit proof: a working mission loop, receipts, and a buyer-visible command surface.
```

Do not sell "AI agents." Sell a paid operating-room outcome: one business loop gets faster, safer, and visible.

## DoorDash Draft

Subject: DoorDash PO invoice processing

Hi [name],

We have the PO and are ready to submit the invoice packet today.

Can you confirm the right AP/procurement contact, required invoice fields, and earliest payable date? If there is any blocker to processing today, send it over and I will clear it immediately.

I can also send W-9, ACH/remittance details, and a PO-matched invoice PDF in the same thread.

Thanks,
Keshav

## Warm Buyer Draft

Subject: 7-day Atris mission room

Hey [name],

We are opening a small number of 7-day Atris mission rooms this week.

The output is not a deck or generic AI demo. We take one operational loop, wire task truth + agent execution + receipts + human accept, and leave you with a proof-backed command surface your team can inspect.

If this is useful, I can scope one loop today and invoice before build.

Keshav

## Daily Operating Loop

```text
08:00  cash standup: cash balance, runway days, invoices, closes, blockers
10:00  DoorDash/AP or top buyer follow-up
12:00  send/collect invoice packets
15:00  close warm prospects into paid pilot or no
18:00  ship one proof artifact for active buyer motion
21:00  update Atris mission receipt and tomorrow cash list
```

Minimum standard: 6 hours sleep. No heroics that damage judgment. The sprint is intense, but the product of the sprint is cash and proof, not exhaustion.

## Eliminate

- No unpaid custom work unless it directly unlocks invoice, PO, payment date, or buyer proof.
- No product polish that is not tied to a live close.
- No vague "pipeline" without a named owner, next action, and payment path.
- No new mission without a verifier or receipt.
- No late-night drift after the cash list is stale; write tomorrow's exact first move and sleep.

## Verifier Contract

Run:

```bash
node scripts/verify-runway-cash-sprint.js
```

The verifier proves this report names the runway, DoorDash PO, July 1 cash day, invoice packet, AP escalation, paid pilot offer, daily loop, eliminate list, and mission receipt contract.

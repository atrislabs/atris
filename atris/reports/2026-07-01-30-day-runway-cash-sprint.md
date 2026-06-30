# 30-Day Runway Cash Sprint

Created: 2026-06-30
Start date: 2026-07-01
Horizon: 30 days to turn committed demand and near-term Atris demand into cash.
Mission: mission-2026-06-29-30-day-runway-cash-sprint-tu-26d7ed54
Task: CLI-554

## Operating Truth

Runway is 30 days. The DoorDash PO exists, but revenue is not cash until the invoice is submitted, accepted, and scheduled for payment.

The goal is not "feel productive." The goal is cash receipt, confirmed payment date, or signed prepaid customer commitment.

```text
July 1, 2026
  -> invoice path confirmed
  -> DoorDash invoice submitted or blocker named
  -> accelerated payment ask sent
  -> 5 cash conversations opened
  -> daily mission loop running
```

## Day 1 Cash Moves

1. DoorDash PO to cash
   - Find exact invoice submission path, AP contact, procurement owner, PO number, billing entity, payment terms, and required invoice fields.
   - Submit the invoice on July 1, 2026 if the path is available.
   - If submission is blocked, send the blocker to procurement/AP and ask for same-day resolution.
   - Ask for expedited ACH or the earliest available pay run because the work is startup-critical.

2. Cash acceleration ask
   - Ask whether DoorDash can approve partial upfront payment, milestone payment, or expedited net terms against the PO.
   - Ask for a written payment date, not just "processing."
   - Capture the answer in Atris as proof.

3. Paid pilot push
   - Open 5 founder-led conversations for paid pilots or annual prepay.
   - Offer a narrow, high-value workflow: "persistent AI computer for your team with proof-backed missions."
   - Ask for money directly: paid pilot, setup fee, or prepaid month.

4. Services wedge
   - Package Atris as a cash-now implementation sprint, not a broad platform demo.
   - Sell one outcome: "we turn your messy workflow into a mission loop with receipts in 48 hours."
   - Price for speed and certainty, not usage.

5. Daily proof loop
   - One cash mission per day.
   - One product proof mission per day.
   - One review/human-accept checkpoint per day.

## DoorDash AP Email

Subject: Invoice submission and expedited payment for PO [PO NUMBER]

Hi [Name],

We have the PO for Atris work and I want to make sure the invoice is submitted correctly today, July 1, 2026.

Can you confirm the invoice submission path, required fields, billing entity, payment terms, and the AP/procurement owner for this PO?

If possible, we would also like to request expedited ACH or the earliest available pay run once the invoice is accepted. This timing matters for our startup runway, and I want to remove any submission issues immediately.

Thanks,
Keshav

## Paid Pilot Message

Hey [Name] - we are opening a few paid Atris implementation slots this week.

The offer is specific: we take one messy workflow, turn it into an AI mission loop, and leave you with proof receipts so you can see what actually happened.

If this is useful, I can run a 48-hour sprint for $[amount] and show the first proof packet by [date].

## Daily Cadence

```text
Wake
  cash status first
  invoice/payment blockers
  5 outbound asks
  1 product proof mission
  1 review lane drain
  sleep protected at 6h minimum
```

Late nights are acceptable. Sleep collapse is not. Six hours is the floor because bad decisions are more expensive than one more tired hour.

## Do Not Touch

- No broad rebuilds unless they unlock cash or proof.
- No vague fundraising motion before invoice/payment blockers are handled.
- No unpriced demos.
- No unpaid custom work.
- No switching endgames mid-day unless cash facts change.

## Success Metrics

- DoorDash invoice submitted.
- DoorDash payment date or explicit blocker recorded.
- 5 direct cash asks sent.
- At least 1 paid pilot/prepay conversation advanced.
- Atris mission receipt created for the day.

## First Verifier

```bash
test -f atris/reports/2026-07-01-30-day-runway-cash-sprint.md && \
grep -q "DoorDash PO to cash" atris/reports/2026-07-01-30-day-runway-cash-sprint.md && \
grep -q "July 1, 2026" atris/reports/2026-07-01-30-day-runway-cash-sprint.md
```

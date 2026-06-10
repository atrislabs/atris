---
type: concept
slug: atris-labs-goals
title: Atris Labs Goals Snapshot
sources:
  - atris/wiki/sources/atris-labs-revenue-snapshot-2026-06-10.md
  - atris/wiki/sources/atris-labs-goals-2026-05-10.txt
created: 2026-04-08
updated: 2026-06-10
last_compiled: 2026-06-10
last_verified: 2026-06-10
confidence: 0.85
dependencies:
  - atris/wiki/systems/atris-labs.md
  - atris/wiki/systems/atris-business.md
  - atris/wiki/concepts/owner-computer-model.md
actionability: "Live numbers are contract/invoice-backed as of 2026-06-10; re-verify against deal folders before quoting externally. Targets remain operating direction."
tags: [atris-labs, goals, north-star, revenue]
---

# Atris Labs Goals Snapshot

Live revenue/customer numbers below are mined from deal-folder evidence (contracts, invoices, send receipts) as of 2026-06-10 — see the dated source snapshot for file-level provenance. The April 2026 targets are kept as operating direction.

## North Star

Build the AI operating system every business runs on. Make Atris Labs the first proof that a company can run through an Atris owner/computer workspace.

The older source also carried a deeper mission: free enough human and machine time to help eliminate disease. That remains vision context, not a current operating metric.

## Live Snapshot — 2026-06-10

| Metric | Value | Evidence |
|--------|-------|----------|
| Signed-contract MRR | **$20,000/mo** | DoorDash $15K/mo (signed 2026-04-06, 12-month term, MSA v3.1 19 May) + Pallet $5K/mo (signed agreement + invoices ATR-2026-003, ATR-2026-005) |
| Closed customers | **2** | DoorDash Ads, Pallet |
| Pending pilot | $200/mo | Fairplay Global — payment unconfirmed as of 2026-05-19 |
| Unsigned pipeline | $2K/mo + Vitalize | Rox agreement drafted, signature blank; Vitalize at proposal/SOW stage |
| Collection risk | Pallet May invoice | ATR-2026-005 ($5,000) sent 2026-06-08, not collected |

Discrepancy note: the April-era page claimed $27K MRR / 4 customers. Deal-folder evidence supports $20K / 2; no files back the extra ~$7K or customers 3-4. Treat $20K/2 as the defensible floor and reconcile against Stripe/bank before quoting higher.

## Q2 2026 Targets (April direction, measured against live snapshot)

| Goal | Measure | Status 2026-06-10 |
|------|---------|-------------------|
| $1M ARR | $83K MRR | $20K signed MRR (24%) |
| 10 closed customers | Logo count | 2 closed + 1 pilot pending + 2 pipeline |
| Reference implementation shipped | Atris Labs workspace dogfooded by team | In progress — DoorDash weekly business review live on real data |
| Nightly synthesis loop live | `STATUS.md` regenerates from state | Partial — brain compile + wiki upkeep loops exist in atris-cli |
| Fundraising workspace stood up | Separate workspace/security boundary | atris-fundraise folder exists; status unverified |

## Historical H2 2026 Direction

- $250K MRR / $3M ARR
- 20+ customers
- first non-founder-led close
- Atris Labs workspace forked by multiple customers
- investor/customer demo where a person can query workspace status and get real answers

## Standing Constraints

- Bay Area only for sponsorship/sports bets in the old goal note.
- No em dashes in outbound copy.
- Never duplicate data into memory that lives in code or customer folders.
- Commit beats hedge under time pressure.

## Current Use

Quote the Live Snapshot table for current company truth; it is the reconciled replacement for the old 0.6-confidence claims. For execution state, use:

- `/Users/keshavrao/arena/atris-business/deals/` — deal/contract/invoice source of truth
- current task or mission queue (`atris task day`, `atris mission status`)
- operator-approved priorities

## Cross-References

- [[atris/wiki/systems/atris-labs.md]] - dogfood workspace orientation
- [[atris/wiki/systems/atris-business.md]] - productized shared-owner workspace
- [[atris/wiki/concepts/owner-computer-model.md]] - owner/computer model

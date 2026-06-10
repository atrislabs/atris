# Atris Labs Revenue/Customer Evidence Snapshot — 2026-06-10

Extracted by devin (CLI-214) from deal-folder evidence in `/Users/keshavrao/arena/atris-business/deals/`. Every line cites the file it came from. This snapshot exists so the wiki page survives even if deal files move.

## Signed / active customers

### DoorDash Ads — $15,000/mo, 12 months
- Fee: "$15,000 per month. Includes platform access, all compute, all model usage, and direct access to the Atris team. Net 30, invoiced monthly. First invoice due upon execution."
  - Source: `/Users/keshavrao/arena/atris-business/deals/atris-doordash/doordash-contract.md` (FEES section)
- Term + signing: "Services agreement signed April 6, 2026 · $15K/mo · 12 months"
  - Source: `/Users/keshavrao/arena/atris-business/deals/atris-doordash/doordash-kickoff-plan-2026-06.md` (header)
- MSA v3.1 dated 19 May 2026 on file: `Atris Labs-DoorDash Master Service Agreement v.3.1 [DoorDash 19MAY2026].docx`
- Security/vendor review closed May 12 2026 (`security-close-receipt-2026-05-12.md`); Cyber + Tech E&O COI on file (`DoorDash_COI_Cyber_TechEO_HealthpointLabs_2026-05-12.pdf`)
- Delivery status: weekly business review live on real data; 30/60/90 kickoff plan prepared for June (kickoff plan, D30 "by mid-July")

### Pallet — $5,000/mo
- Signed agreement on file: `/Users/keshavrao/arena/atris-business/deals/atris_pallet/Pallet-Atris-Agreement.pdf`
- Invoice ATR-2026-003 (April 2026) sent 2026-04-28 to ap@pallet.com (Gmail msg `19dd2e7fcebdee72`)
- Invoice ATR-2026-005 (May 2026, $5,000.00) sent 2026-06-08 (Gmail msg `19ea8ebcb48f6a60`); status: **sent, not collected**
  - Source: `/Users/keshavrao/arena/atris-business/deals/atris_pallet/invoice-log.md`
- Delivery status: 22 skills built / 8 ran; 8 of 34 members onboarded; 8 customer-side blockers open (Greenhouse key, Slack OAuth, etc.)
  - Source: `/Users/keshavrao/arena/atris-business/deals/atris_pallet/tracker.md`

## Pending / pilot

### Fairplay Global — $200/mo working assumption, pilot
- `pro_pilot_state.json` (generated 2026-05-19): status `pending_payment_confirmation`, payer sanjay, payment_confirmed false, amount source "user-stated working assumption"
  - Source: `/Users/keshavrao/arena/atris-business/deals/atris-fairplay-global/pro_pilot_state.json`

## Unsigned pipeline

### Rox — $2,000/mo proposed
- Agreement drafted at $2,000/mo, signature and date lines **blank** (proposal, not closed)
  - Source: `/Users/keshavrao/arena/atris-business/deals/atris_rox/rox-atris-agreement.md`

### Vitalize — no contract value on file
- Proposal, SOW, demo agenda, HubSpot pipeline notes exist; no signed agreement or invoice evidence
  - Source: `/Users/keshavrao/arena/atris-business/deals/atris_vitalize/`

## Rollup (as of 2026-06-10)

| Metric | Value | Basis |
|--------|-------|-------|
| Signed-contract MRR | $20,000/mo | DoorDash $15K (signed 4/6, 12mo) + Pallet $5K (agreement + invoices) |
| Closed customers | 2 | DoorDash, Pallet |
| Pending pilot | $200/mo | Fairplay (payment unconfirmed as of 5/19) |
| Unsigned pipeline | $2,000/mo + Vitalize | Rox draft; Vitalize proposal stage |
| Cash collection risk | Pallet May invoice | ATR-2026-005 sent 6/8, not collected |

## Discrepancy vs. old page

The April-era page claimed "$27K MRR / 4 customers." Current deal-folder evidence supports $20K signed MRR and 2 closed customers; no evidence was found for the additional ~$7K or the 3rd/4th customer. Either that evidence lives outside `deals/` (e.g. Stripe) or the old claim included pipeline. Treat $20K/2 as the defensible floor.

## Search audit (what was checked)

- `deals/` folders: atris-doordash, atris_pallet, atris_rox, atris_vitalize, atris-fairplay-global, big-labs (intel only, no Atris revenue)
- Invoice numbering ATR-2026-*: only 003 and 005 appear in the repo
- `atris-labs/sales/` (notes + templates only), `agentgrads/`, `atris-partners/` (no revenue evidence)
- `~/.atris/crm_state.json` (empty), `~/.atris/businesses.json` (workspace registrations only)

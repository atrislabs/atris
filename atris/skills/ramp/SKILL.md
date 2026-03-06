---
name: ramp
description: Ramp corporate card and spend management. Use when user asks about expenses, transactions, cards, spend analysis, burn rate, or corporate finance. Triggers on ramp, expenses, transactions, spend, corporate card, burn rate.
version: 1.0.0
tags:
  - ramp
  - finance
  - integration
  - expenses
---

# Ramp

Corporate spend management via Ramp API. No OAuth needed — API key auth.

## Setup

User needs a Ramp API key from their Ramp dashboard (Settings > Developer API).

Store locally (default):
```bash
mkdir -p ~/.atris/secrets/ramp
read -s -p "Ramp API key: " key
printf '%s' "$key" > ~/.atris/secrets/ramp/API_KEY
chmod 600 ~/.atris/secrets/ramp/API_KEY
unset key
echo "Saved."
```

The key is available at runtime as `RAMP_API_KEY` env var.

## API Reference

Base URL: `https://api.ramp.com/developer/v1`

Auth header: `Authorization: Bearer $RAMP_API_KEY`

All responses are JSON. List endpoints support `start` (cursor) and `page_size` params for pagination.

---

## Transactions

### List Transactions
```bash
curl -s "https://api.ramp.com/developer/v1/transactions?page_size=50" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

Filter params:
- `from_date` / `to_date` — ISO 8601 (e.g. `2026-03-01`)
- `department_id` — filter by department
- `merchant_id` — filter by merchant
- `user_id` — filter by cardholder
- `min_amount` / `max_amount` — in cents
- `state` — PENDING, CLEARED, DECLINED

### Get Transaction
```bash
curl -s "https://api.ramp.com/developer/v1/transactions/{transaction_id}" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

---

## Cards

### List Cards
```bash
curl -s "https://api.ramp.com/developer/v1/cards?page_size=50" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

### Get Card
```bash
curl -s "https://api.ramp.com/developer/v1/cards/{card_id}" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

### Create Virtual Card
```bash
curl -s -X POST "https://api.ramp.com/developer/v1/cards/deferred/virtual" \
  -H "Authorization: Bearer $RAMP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Marketing Q1",
    "user_id": "USER_ID",
    "spending_restrictions": {
      "amount": 500000,
      "interval": "MONTHLY",
      "lock_date": null,
      "categories": []
    }
  }'
```

### Update Card (limits, name, owner)
```bash
curl -s -X PATCH "https://api.ramp.com/developer/v1/cards/{card_id}" \
  -H "Authorization: Bearer $RAMP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "New Name",
    "spending_restrictions": {"amount": 100000, "interval": "MONTHLY"}
  }'
```

### Suspend Card
```bash
curl -s -X POST "https://api.ramp.com/developer/v1/cards/{card_id}/deferred/suspension" \
  -H "Authorization: Bearer $RAMP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Terminate Card
```bash
curl -s -X POST "https://api.ramp.com/developer/v1/cards/{card_id}/deferred/termination" \
  -H "Authorization: Bearer $RAMP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## Company

### Get Company Info
```bash
curl -s "https://api.ramp.com/developer/v1/business" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

### Get Company Balance
```bash
curl -s "https://api.ramp.com/developer/v1/business/balance" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

---

## Users

### List Users
```bash
curl -s "https://api.ramp.com/developer/v1/users?page_size=50" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

### Get User
```bash
curl -s "https://api.ramp.com/developer/v1/users/{user_id}" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

---

## Departments

### List Departments
```bash
curl -s "https://api.ramp.com/developer/v1/departments" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

### Create Department
```bash
curl -s -X POST "https://api.ramp.com/developer/v1/departments" \
  -H "Authorization: Bearer $RAMP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Engineering"}'
```

---

## Bills

### List Bills
```bash
curl -s "https://api.ramp.com/developer/v1/bills?page_size=50" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

### Create Bill
```bash
curl -s -X POST "https://api.ramp.com/developer/v1/bills" \
  -H "Authorization: Bearer $RAMP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": {"amount": 150000, "currency_code": "USD"},
    "vendor_name": "AWS",
    "invoice_number": "INV-001",
    "due_date": "2026-04-01",
    "memo": "March hosting"
  }'
```

---

## Reimbursements

### List Reimbursements
```bash
curl -s "https://api.ramp.com/developer/v1/reimbursements?page_size=50" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

---

## Cashbacks

### List Cashback Payments
```bash
curl -s "https://api.ramp.com/developer/v1/cashbacks?page_size=50" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

---

## Accounting

### List GL Accounts
```bash
curl -s "https://api.ramp.com/developer/v1/accounting/accounts" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

### List Vendors
```bash
curl -s "https://api.ramp.com/developer/v1/accounting/vendors" \
  -H "Authorization: Bearer $RAMP_API_KEY"
```

---

## Workflows

### "What are we spending on?"
1. Pull transactions: `GET /transactions?from_date=2026-03-01&to_date=2026-03-31`
2. Group by merchant name
3. Sort by total amount descending
4. Report top 10 merchants and total spend

### "Monthly burn rate"
1. Pull transactions for last 3 months
2. Sum cleared transactions per month
3. Calculate average monthly spend
4. Get company balance: `GET /business/balance`
5. Runway = balance / average_monthly_burn

### "Subscription audit"
1. Pull 90 days of transactions
2. Find recurring merchants (same merchant, similar amounts, monthly cadence)
3. Flag: unused (no logins), duplicate (overlapping tools), expensive (>$500/mo)
4. Report with recommendation per subscription

### "Create a project card"
1. Find the user: `GET /users` → match by name/email
2. **Confirm with user: "Create virtual card 'Project X' with $5,000/mo limit for {user}?"**
3. Create card: `POST /cards/deferred/virtual`
4. Return card details

### "Department spend breakdown"
1. List departments: `GET /departments`
2. For each department, pull transactions filtered by `department_id`
3. Summarize spend per department
4. Highlight departments over/under budget

### "Anomaly detection"
1. Pull last 30 days of transactions
2. Calculate per-merchant averages from prior 90 days
3. Flag transactions >2x the merchant average
4. Flag new merchants with spend >$500
5. Flag weekend/holiday transactions
6. Report anomalies with context

## Amounts

All monetary amounts in the Ramp API are in **cents** (integer). $150.00 = 15000.

## Pagination

List endpoints return `{ "data": [...], "page": { "next": "cursor_string" } }`.

To get next page: add `?start=cursor_string` to the request.

## Rate Limits

Ramp applies rate limits per API key. If you get 429, wait and retry with exponential backoff.

## Full API Spec

For the complete OpenAPI spec: `https://docs.ramp.com/openapi/developer-api.json`

For AI-readable docs: `https://docs.ramp.com/llms.txt`

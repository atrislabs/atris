---
name: commerce
description: "Buy or trade through Atris for a person: get a quote, show it, the person approves, check status, read their transactions. Use when asked to buy tickets, buy an item from a store, place a stock order, or list what someone bought or traded. Triggers on buy, purchase, order, trade, stock order, transactions, what did I spend."
version: 1.0.0
tags:
  - commerce
  - money
---

# Commerce: buy or trade through Atris

You can quote and ask. Only the human can pay. Every dollar leaves only after
the person acts themselves: a tap in their Link app, a payment page they
fill in, or a text from their own phone.

## The loop

1. Quote. `atris buy quote --kind <kind> [fields]`.
2. Show the person the summary, total, fee and approval text. Word for word on money.
3. Only after they say yes, approve. `atris buy approve <id> [fields]`.
4. Hand the person the approval link (Link or payment page). For trades, tell them to check their texts: Atris sends the one-time code only to their own text thread, never to you. Nothing else pays.
5. Check `atris buy status <id>` until the state is `done`, `failed`, `refunded` or `unknown`.
6. `atris transactions` lists everything they bought, paid in fees, traded or sent.

Add `--json` to any command for the raw response.

## Kinds

| kind | quote flags | approve flags | human approves by |
|---|---|---|---|
| `ticket` | `--event-url` (vividseats.com), `--quantity`, `--min-each-usd`, `--max-each-usd` | `--pick` (1-3 or ticket_id), `--delivery-email` | Link app, or payment page |
| `shop` | `--query` or `--url`, `--quantity` | `--options '<json>'`, `--delivery-email`, `--address '<json>'` (US, once), `--accept-extras` | Link app |
| `trade` | `--side` buy/sell, `--symbol`, `--quantity` or `--dollars`, `--order-type` market/limit, `--limit-price` | none | replying to Atris's text with the exact phrase from their own phone, within 5 minutes |
| `flight` | not wired yet, quotes are refused | | |

Any field can also go in as JSON: `--intent '{"kind":"shop","query":"navy tee"}'` for quotes,
`--details '{"pick":"1"}'` for approve. Flags win over the JSON.

## Rails (enforced in code, not by you)

- Approval is always human. An API key cannot confirm a trade or approve a Link spend.
- Caps: purchases up to `TEXT_TICKETS_MAX_USD` (default $400) and $500 per Link spend. Stocks: per-order and per-day caps, the Robinhood risk policy, market hours, no shorting, stocks only.
- Quotes expire: 30 minutes for purchases, 10 for trades. A trade quote stages at most one order. Ask again after that.
- A trade already waiting for the person's yes blocks a new one. Let them confirm or let it expire.
- No retries. If a result is `unknown`, money may have moved. Tell the person to check the store or Robinhood app. Never buy again to "fix" it.
- No advice on trades. Carry out only the person's own instruction.
- For Link-mode orders, status may carry `fee_payment_url`: the page where the person pays the Atris fee. The CLI prints it as "Pay the Atris fee".
- Status values from quote and approve: `quoted`, `pending_approval`, `needs_input` (ask the person for the named field), `needs_setup` (send them the connect link), `refused` (read the message to them).

## With the CLI

```bash
# Tickets
atris buy quote --kind ticket --event-url "https://www.vividseats.com/..." --quantity 2
atris buy approve ord_<uuid> --pick 1 --delivery-email sam@example.com
# -> Approve in Link: https://...   Nothing has been charged yet.

# A store item
atris buy quote --kind shop --query "uniqlo supima crew tee navy" --quantity 1

# A stock order
atris buy quote --kind trade --side buy --symbol VTI --dollars 25
atris buy approve trq_<token>
# -> We texted you a confirm code. Reply to that text to place the trade.

# Status and history
atris buy status ord_<uuid>
atris transactions --since 2026-09-01 --kind ticket,shop,trade --limit 50
# Quotes nobody approved are left out; add --include-quotes to see them.
```

## With curl

```bash
KEY="Authorization: Bearer $ATRIS_API_KEY"
API=https://api.atris.ai/api

curl -s -X POST $API/commerce/quote -H "$KEY" -H 'content-type: application/json' \
  -d '{"kind":"ticket","event_url":"https://www.vividseats.com/...","quantity":2}'
curl -s -X POST $API/commerce/ord_<uuid>/approve -H "$KEY" -H 'content-type: application/json' \
  -d '{"pick":"1","delivery_email":"sam@example.com"}'
# -> {"status":"pending_approval","approval":{"how":"link_app","url":"https://..."}}

curl -s -X POST $API/commerce/quote -H "$KEY" -H 'content-type: application/json' \
  -d '{"kind":"trade","side":"buy","symbol":"VTI","dollars":25}'
curl -s -X POST $API/commerce/trq_<token>/approve -H "$KEY"
# -> {"status":"pending_approval","approval":{"how":"text_confirm","text":"Check your texts. ..."}}

curl -s $API/commerce/ord_<uuid> -H "$KEY"
curl -s "$API/transactions?since=2026-09-01&kinds=ticket,shop,trade&limit=50" -H "$KEY"
# Quotes nobody approved are left out; add &include_quotes=true to see them.
```

Each transaction: `id, kind, when, what, amount_cents, currency, state, counterparty, receipt_url`.
`sources` says which ledgers loaded; if one says `failed`, the list is partial. Say so.
The CLI prints that as "Partial list: could not load ...".

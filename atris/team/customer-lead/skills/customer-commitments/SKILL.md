---
name: customer-commitments
description: Turn real customer evidence into a compact commitment view, retention risk, and one approval-gated next action. Use when reviewing customer feedback, follow-ups, promises, churn signals, or retention risk.
version: 1.0.0
tags:
  - customer-success
  - retention
  - commitments
---

# Customer Commitments

Use this skill when a customer outcome, promise, follow-up, or retention risk
needs an owner and a trustworthy next action.

## Workflow

1. Read only the customer evidence available in the workspace.
2. Record the customer, desired outcome, latest signal, commitment, owner, due date, state, source, and confidence.
3. Use only four states: on track, needs attention, broken, or unknown.
4. Draft one next action tied to the desired outcome and existing evidence.
5. Route product defects or requests into the existing feedback or task system.
6. Stop for human approval before sending, publishing, discounting, refunding, or making a commercial or roadmap promise.

## Guardrails

- Never manufacture usage, sentiment, renewal, or revenue data.
- Never replace missing evidence with a composite health score.
- Never create a parallel product backlog from customer notes.
- Keep the view small enough that an owner can see the next commitment immediately.

## Example

Input: "The customer asked about exports last week, and we promised an answer by Friday."

Output: Record the customer's export outcome, the dated request as evidence,
the promised answer and its owner, Friday as the due date, the state as needs
attention, and one approval-gated follow-up. Leave any missing owner or customer
sentiment unknown.

## Troubleshooting

- If sources conflict, show both signals, lower confidence, and ask the owner to resolve them.
- If no owner or due date exists, mark it unknown and propose one for approval.
- If the next action is product work, link or update the existing task instead of opening a parallel backlog.

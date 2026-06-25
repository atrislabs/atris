---
name: atris-feedback
description: Submit, list, resolve, close, or delete Atris customer feedback. Use when user types /feedback or asks to triage the feedback queue.
version: 1.0.0
tags:
  - feedback
  - customer
  - admin
---

# Feedback

One skill for everything: submit feedback, view the queue, resolve/close/delete items.

## Steps

1. Parse the user input to determine the feedback action (list, submit, resolve, close, delete)
2. Run the matching `atris feedback` CLI command from the reference below
3. If `atris` CLI is unavailable, fall back to the direct API/DynamoDB path
4. Report the result to the user

## Parse the input

- `/feedback` (no args) → show the queue
- `/feedback <message>` → submit new feedback
- `/feedback resolve <id> <resolution>` → mark as resolved, notify customer
- `/feedback close <id>` → close as wontfix/duplicate
- `/feedback delete <id>` → remove from queue

## Preferred path: the Atris CLI

The `atris` CLI wraps every feedback operation against the production API and
handles auth from the user's login. Use it first — it's the canonical,
audited path and works without needing AWS credentials.

```bash
atris feedback                              # list queue
atris feedback "the calendar hangs"         # submit
atris feedback resolve abc123 "fixed"       # mark resolved
atris feedback close abc123                 # close as wontfix
atris feedback delete abc123                # delete
```

IDs can be short (first 8 chars of the UUID) — the CLI resolves the prefix
against the live list before acting.

If `atris` is not on PATH, it lives at `~/arena/atris-cli/bin/atris.js`.

## Fallback: direct API / DynamoDB

Only use this path if the CLI is unavailable (stale install, broken login).

### Setup

Use this only from a trusted service workspace with AWS credentials already
configured. Do not ask end users to clone or run backend services locally.

```python
from dotenv import load_dotenv; load_dotenv('backend/.env')
import boto3
table = boto3.resource('dynamodb', region_name='us-east-1').Table('atris_feedback')
```

### Submit

```bash
curl -s -X POST "https://api.atris.ai/api/feedback" \
  -H "Content-Type: application/json" \
  -H "X-Feedback-Key: $FEEDBACK_API_KEY" \
  -d '{"message": "THE_MESSAGE", "source": "cli", "context": {"user_email": "GIT_EMAIL"}}'
```

Confirm: `Feedback submitted (id: abc123)`

### Resolve

```python
table.update_item(
    Key={'id': FULL_ID},
    UpdateExpression='SET #s = :s, resolution = :r, resolved_at = :t',
    ExpressionAttributeNames={'#s': 'status'},
    ExpressionAttributeValues={':s': 'resolved', ':r': RESOLUTION, ':t': NOW},
)
```

Print: `Resolved abc123: <resolution>`

### Close

Same as resolve but `status = 'closed'`, no resolution text needed.

### Delete

```python
table.delete_item(Key={'id': FULL_ID})
```

Print: `Deleted abc123`

### ID matching

Users type short IDs (first 8 chars). Scan the table and match by prefix
to find the full UUID.

## Security

- NEVER include API keys, tokens, or secrets in feedback messages
- Server-side sanitization strips them anyway (double protection)
- Max 2000 chars per message

## Output

Always print the result directly as text. Never leave it inside a tool
call expansion.

---
name: email-agent
description: Gmail integration via AtrisOS API. Read, send, archive emails. Use when user asks about email, inbox, or wants to send/check messages.
---

# Email Agent

> Drop this in `~/.claude/skills/email-agent/SKILL.md` and Claude Code becomes your email assistant.

## Bootstrap (ALWAYS Run First)

Before any email operation, run this bootstrap to ensure everything is set up:

```bash
#!/bin/bash
set -e

# 1. Check if atris CLI is installed
if ! command -v atris &> /dev/null; then
  echo "Installing atris CLI..."
  npm install -g atris
fi

# 2. Check if logged in to AtrisOS
if [ ! -f ~/.atris/credentials.json ]; then
  echo "Not logged in to AtrisOS."
  echo ""
  echo "Option 1 (interactive): Run 'atris login' and follow prompts"
  echo "Option 2 (non-interactive): Get token from https://atris.ai/auth/cli"
  echo "                           Then run: atris login --token YOUR_TOKEN"
  echo ""
  exit 1
fi

# 3. Extract token (try node first, then python3, then jq)
if command -v node &> /dev/null; then
  TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
elif command -v python3 &> /dev/null; then
  TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.atris/credentials.json')))['token'])")
elif command -v jq &> /dev/null; then
  TOKEN=$(jq -r '.token' ~/.atris/credentials.json)
else
  echo "Error: Need node, python3, or jq to read credentials"
  exit 1
fi

# 4. Check Gmail connection status (also validates token)
STATUS=$(curl -s "https://api.atris.ai/api/integrations/gmail/status" \
  -H "Authorization: Bearer $TOKEN")

# Check for token expiry
if echo "$STATUS" | grep -q "Token expired\|Not authenticated"; then
  echo "Token expired. Please re-authenticate:"
  echo "  Run: atris login --force"
  echo "  Or get new token from: https://atris.ai/auth/cli"
  exit 1
fi

# Parse connected status
if command -v node &> /dev/null; then
  CONNECTED=$(node -e "console.log(JSON.parse('$STATUS').connected || false)")
elif command -v python3 &> /dev/null; then
  CONNECTED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected', False))")
else
  CONNECTED=$(echo "$STATUS" | jq -r '.connected // false')
fi

if [ "$CONNECTED" != "true" ] && [ "$CONNECTED" != "True" ]; then
  echo "Gmail not connected. Getting authorization URL..."
  AUTH=$(curl -s -X POST "https://api.atris.ai/api/integrations/gmail/start" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}')

  if command -v node &> /dev/null; then
    URL=$(node -e "console.log(JSON.parse('$AUTH').auth_url || '')")
  elif command -v python3 &> /dev/null; then
    URL=$(echo "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auth_url', ''))")
  else
    URL=$(echo "$AUTH" | jq -r '.auth_url // empty')
  fi

  echo ""
  echo "Open this URL to connect your Gmail:"
  echo "$URL"
  echo ""
  echo "After authorizing, run your email command again."
  exit 0
fi

echo "Ready. Gmail is connected."
export ATRIS_TOKEN="$TOKEN"
```

**Important**: Run this script ONCE before email operations. If it exits with instructions, follow them, then run again.

---

## API Reference

Base: `https://api.atris.ai/api/integrations/gmail`

All requests require: `-H "Authorization: Bearer $TOKEN"`

### Get Token (after bootstrap)
```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
```

### List Emails
```bash
curl -s "https://api.atris.ai/api/integrations/gmail/messages?query=in:inbox&max_results=20" \
  -H "Authorization: Bearer $TOKEN"
```

**Query syntax** (Gmail search):
- `in:inbox` — inbox only
- `in:inbox newer_than:1d` — today's emails
- `is:unread` — unread only
- `from:someone@example.com` — from specific sender
- `subject:invoice` — subject contains word
- `has:attachment` — emails with attachments

### Read Single Email
```bash
curl -s "https://api.atris.ai/api/integrations/gmail/messages/{message_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Send Email
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/gmail/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "recipient@example.com",
    "subject": "Subject line",
    "body": "Email body text"
  }'
```

**With CC/BCC:**
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/gmail/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "recipient@example.com",
    "cc": "copy@example.com",
    "bcc": ["hidden1@example.com", "hidden2@example.com"],
    "subject": "Subject line",
    "body": "Email body text"
  }'
```

**With attachments:**
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/gmail/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "recipient@example.com",
    "subject": "With attachment",
    "body": "See attached.",
    "attachments": [{"filename": "report.txt", "content": "base64-encoded-content", "mime_type": "text/plain"}]
  }'
```

### Archive Email
```bash
# Single message
curl -s -X POST "https://api.atris.ai/api/integrations/gmail/messages/{message_id}/archive" \
  -H "Authorization: Bearer $TOKEN"

# Batch archive
curl -s -X POST "https://api.atris.ai/api/integrations/gmail/messages/batch-archive" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message_ids": ["id1", "id2", "id3"]}'
```

### Check Status
```bash
curl -s "https://api.atris.ai/api/integrations/gmail/status" \
  -H "Authorization: Bearer $TOKEN"
```

### Disconnect Gmail
```bash
curl -s -X DELETE "https://api.atris.ai/api/integrations/gmail" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Workflows

### "Check my emails"
1. Run bootstrap
2. List messages: `GET /messages?query=in:inbox%20newer_than:1d&max_results=20`
3. Display: sender, subject, snippet for each

### "Send email to X about Y"
1. Run bootstrap
2. Draft email content
3. **Show user the draft for approval**
4. On approval: `POST /send` with `{to, subject, body}`
5. Confirm: "Email sent!"

### "Clean up my inbox"
1. Run bootstrap
2. List: `GET /messages?query=in:inbox&max_results=50`
3. Identify archivable emails (see rules below)
4. **Show user what will be archived, get approval**
5. Batch archive: `POST /batch-archive`

### "Archive all from [sender]"
1. Run bootstrap
2. Search: `GET /messages?query=from:{sender}`
3. Collect message IDs
4. **Confirm with user**: "Found N emails from {sender}. Archive all?"
5. Batch archive

---

## Auto-Archive Rules

**Safe to suggest archiving:**
- From: `noreply@`, `notifications@`, `newsletter@`, `no-reply@`
- Subject contains: digest, newsletter, notification, weekly update, daily summary
- Marketing: promotional, unsubscribe link present

**NEVER auto-archive (always keep):**
- Subject contains: invoice, receipt, payment, urgent, action required, password, verification, security
- From known contacts (check if user has replied to them)
- Flagged/starred messages

**Always ask before archiving.** Never archive without explicit user approval.

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `Token expired` | AtrisOS session expired | Run `atris login` |
| `Gmail not connected` | OAuth not completed | Re-run bootstrap, complete OAuth flow |
| `401 Unauthorized` | Invalid/expired token | Run `atris login` |
| `400 Gmail not connected` | No Gmail credentials | Complete OAuth via bootstrap |
| `429 Rate limited` | Too many requests | Wait 60s, retry |
| `Invalid grant` | Google revoked access | Re-connect Gmail via bootstrap |

---

## Security Model

1. **Local token** (`~/.atris/credentials.json`): Your AtrisOS auth token, stored locally with 600 permissions. Same model as AWS CLI, GitHub CLI.

2. **Gmail credentials**: Your Gmail refresh token is stored **server-side** in AtrisOS encrypted vault. Never stored on your local machine.

3. **Access control**: AtrisOS API enforces that you can only access your own email. No cross-user access possible.

4. **OAuth scopes**: Only requests necessary Gmail permissions (read, send, modify labels).

5. **HTTPS only**: All API communication encrypted in transit.

---

## Quick Reference

```bash
# Setup (one time)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Check connection
curl -s "https://api.atris.ai/api/integrations/gmail/status" -H "Authorization: Bearer $TOKEN"

# List inbox
curl -s "https://api.atris.ai/api/integrations/gmail/messages?query=in:inbox&max_results=10" -H "Authorization: Bearer $TOKEN"

# Send email
curl -s -X POST "https://api.atris.ai/api/integrations/gmail/send" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"email@example.com","subject":"Hi","body":"Hello!"}'
```

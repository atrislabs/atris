---
name: slack
description: Slack integration via AtrisOS API. Read messages, send as yourself, search conversations, manage DMs. Use when user asks about Slack, messages, channels, or team communication.
version: 1.0.0
tags:
  - slack
  - backend
  - messaging
---

# Slack Agent

> Drop this in `~/.claude/skills/slack/SKILL.md` and Claude Code becomes your Slack assistant.

## Bootstrap (ALWAYS Run First)

Before any Slack operation, run this bootstrap to ensure everything is set up:

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

# 3. Extract token
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

# 4. Check Slack connection status
STATUS=$(curl -s "https://api.atris.ai/api/integrations/slack/status" \
  -H "Authorization: Bearer $TOKEN")

if echo "$STATUS" | grep -q "Token expired\|Not authenticated"; then
  echo "Token expired. Please re-authenticate:"
  echo "  Run: atris login --force"
  exit 1
fi

if command -v node &> /dev/null; then
  CONNECTED=$(node -e "try{console.log(JSON.parse('$STATUS').connected||false)}catch(e){console.log(false)}")
elif command -v python3 &> /dev/null; then
  CONNECTED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected', False))")
else
  CONNECTED=$(echo "$STATUS" | jq -r '.connected // false')
fi

if [ "$CONNECTED" != "true" ] && [ "$CONNECTED" != "True" ]; then
  echo "Slack not connected. Getting authorization URL..."
  AUTH=$(curl -s -X POST "https://api.atris.ai/api/integrations/slack/start" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"mode":"personal"}')

  if command -v node &> /dev/null; then
    URL=$(node -e "try{console.log(JSON.parse('$AUTH').auth_url||'')}catch(e){console.log('')}")
  elif command -v python3 &> /dev/null; then
    URL=$(echo "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auth_url', ''))")
  else
    URL=$(echo "$AUTH" | jq -r '.auth_url // empty')
  fi

  echo ""
  echo "Open this URL to connect your Slack:"
  echo "$URL"
  echo ""
  echo "After authorizing, run your command again."
  exit 0
fi

echo "Ready. Slack is connected."
export ATRIS_TOKEN="$TOKEN"
```

---

## API Reference

Base: `https://api.atris.ai/api/integrations`

All requests require: `-H "Authorization: Bearer $TOKEN"`

### Get Token (after bootstrap)
```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
```

---

## Personal Endpoints (send/read as yourself)

These use your personal Slack token. Messages appear as YOU, not a bot.

### List Your Channels & DMs
```bash
curl -s "https://api.atris.ai/api/integrations/slack/me/channels" \
  -H "Authorization: Bearer $TOKEN"
```

### List Your DMs
```bash
curl -s "https://api.atris.ai/api/integrations/slack/me/dms" \
  -H "Authorization: Bearer $TOKEN"
```

### Read Messages from a Channel or DM
```bash
curl -s "https://api.atris.ai/api/integrations/slack/me/messages/{channel_id}?limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Send Message as Yourself
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/slack/me/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "C0123CHANNEL",
    "text": "Hey team, here is the update..."
  }'
```

**Reply in a thread:**
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/slack/me/send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "C0123CHANNEL",
    "text": "Following up on this...",
    "thread_ts": "1234567890.123456"
  }'
```

### DM Someone as Yourself
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/slack/me/dm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slack_user_id": "U0123USER",
    "text": "Hey, quick question about the project..."
  }'
```

### Search Messages
```bash
curl -s "https://api.atris.ai/api/integrations/slack/me/search?q=quarterly+report&count=20" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Workspace Endpoints

### List Channels (bot view)
```bash
curl -s "https://api.atris.ai/api/integrations/slack/channels" \
  -H "Authorization: Bearer $TOKEN"
```

### List Users
```bash
curl -s "https://api.atris.ai/api/integrations/slack/users" \
  -H "Authorization: Bearer $TOKEN"
```

### Send as Bot
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/slack/test-send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "C0123CHANNEL",
    "message": "Hello from Atris!"
  }'
```

### Check Connection Status
```bash
curl -s "https://api.atris.ai/api/integrations/slack/status" \
  -H "Authorization: Bearer $TOKEN"
```

### Disconnect Slack
```bash
curl -s -X DELETE "https://api.atris.ai/api/integrations/slack" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Workflows

### "Check my Slack messages"
1. Run bootstrap
2. List DMs: `GET /slack/me/dms`
3. For each open DM, read recent messages: `GET /slack/me/messages/{channel_id}?limit=5`
4. Resolve user names: `GET /slack/users`
5. Display: who messaged, what they said, when

### "Send a message to someone"
1. Run bootstrap
2. Find the user: `GET /slack/users` (search by name/email)
3. **Show user the draft for approval**
4. Send DM: `POST /slack/me/dm` with `{user_id, text}`
5. Confirm: "Message sent!"

### "Reply in a channel"
1. Run bootstrap
2. List channels: `GET /slack/me/channels`
3. Find the right channel
4. Read recent messages: `GET /slack/me/messages/{channel_id}`
5. **Show user the draft for approval**
6. Send: `POST /slack/me/send` with `{channel, text}`

### "Find a conversation about X"
1. Run bootstrap
2. Search: `GET /slack/me/search?q=X`
3. Display matching messages with channel, sender, permalink

### "What did [person] say to me?"
1. Run bootstrap
2. List users: `GET /slack/users` (find user ID)
3. List DMs: `GET /slack/me/dms` (find DM channel with that user)
4. Read messages: `GET /slack/me/messages/{channel_id}`
5. Display conversation

---

## Important Notes

- **Personal endpoints** (`/slack/me/*`) send messages as YOU, not a bot
- **Bot endpoints** (`/slack/channels`, `/slack/test-send`) use the bot token
- **Always get approval** before sending messages on behalf of the user
- **Thread replies**: include `thread_ts` to reply in a thread instead of creating a new message
- **User IDs**: Slack uses IDs like `U0123ABC`. Get them from `/slack/users` endpoint
- **Channel IDs**: Use IDs like `C0123ABC`. Get them from `/slack/me/channels`

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `Token expired` | AtrisOS session expired | Run `atris login` |
| `Slack not connected` | OAuth not completed | Re-run bootstrap |
| `Personal Slack not connected` | No user token | Re-connect Slack (needs re-auth for personal access) |
| `401 Unauthorized` | Invalid/expired token | Run `atris login` |
| `channel_not_found` | Invalid channel ID | Use `/slack/me/channels` to find correct ID |
| `not_in_channel` | User not in channel | Join the channel first |

---

## Security Model

1. **Local token** (`~/.atris/credentials.json`): Your AtrisOS auth token, stored locally.
2. **Slack credentials**: Bot token and user token stored **server-side** in AtrisOS encrypted vault.
3. **Two token types**: Bot token (xoxb-) for workspace operations, User token (xoxp-) for personal operations.
4. **Access control**: AtrisOS API enforces that you can only access your own Slack.
5. **HTTPS only**: All API communication encrypted in transit.

---

## Quick Reference

```bash
# Setup (one time)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Check connection
curl -s "https://api.atris.ai/api/integrations/slack/status" -H "Authorization: Bearer $TOKEN"

# List your DMs
curl -s "https://api.atris.ai/api/integrations/slack/me/dms" -H "Authorization: Bearer $TOKEN"

# Read messages
curl -s "https://api.atris.ai/api/integrations/slack/me/messages/CHANNEL_ID" -H "Authorization: Bearer $TOKEN"

# Send as yourself
curl -s -X POST "https://api.atris.ai/api/integrations/slack/me/send" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"C0123","text":"Hello!"}'

# DM someone as yourself
curl -s -X POST "https://api.atris.ai/api/integrations/slack/me/dm" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"user_id":"U0123","text":"Hey!"}'

# Search messages
curl -s "https://api.atris.ai/api/integrations/slack/me/search?q=project+update" -H "Authorization: Bearer $TOKEN"

# List workspace users
curl -s "https://api.atris.ai/api/integrations/slack/users" -H "Authorization: Bearer $TOKEN"
```

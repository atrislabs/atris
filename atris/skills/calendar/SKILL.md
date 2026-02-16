---
name: calendar
description: Google Calendar integration via AtrisOS API. View, create, and manage calendar events. Use when user asks about calendar, schedule, meetings, or events.
version: 1.0.0
tags:
  - calendar
  - backend
  - google-calendar
---

# Calendar Agent

> Drop this in `~/.claude/skills/calendar/SKILL.md` and Claude Code becomes your calendar assistant.

## Bootstrap (ALWAYS Run First)

Before any calendar operation, run this bootstrap to ensure everything is set up:

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

# 4. Check Google Calendar connection status (also validates token)
STATUS=$(curl -s "https://api.atris.ai/api/integrations/google-calendar/status" \
  -H "Authorization: Bearer $TOKEN")

# Check for token expiry
if echo "$STATUS" | grep -q "Token expired\|Not authenticated"; then
  echo "Token expired. Please re-authenticate:"
  echo "  Run: atris login --force"
  exit 1
fi

# Parse connected status
if command -v node &> /dev/null; then
  CONNECTED=$(node -e "try{console.log(JSON.parse('$STATUS').connected||false)}catch(e){console.log(false)}")
elif command -v python3 &> /dev/null; then
  CONNECTED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected', False))")
else
  CONNECTED=$(echo "$STATUS" | jq -r '.connected // false')
fi

if [ "$CONNECTED" != "true" ] && [ "$CONNECTED" != "True" ]; then
  echo "Google Calendar not connected. Getting authorization URL..."
  AUTH=$(curl -s -X POST "https://api.atris.ai/api/integrations/google-calendar/start" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"redirect_uri":"https://api.atris.ai/api/integrations/google-calendar/callback"}')

  if command -v node &> /dev/null; then
    URL=$(node -e "try{console.log(JSON.parse('$AUTH').auth_url||'')}catch(e){console.log('')}")
  elif command -v python3 &> /dev/null; then
    URL=$(echo "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auth_url', ''))")
  else
    URL=$(echo "$AUTH" | jq -r '.auth_url // empty')
  fi

  echo ""
  echo "Open this URL to connect your Google Calendar:"
  echo "$URL"
  echo ""
  echo "After authorizing, run your calendar command again."
  exit 0
fi

echo "Ready. Google Calendar is connected."
export ATRIS_TOKEN="$TOKEN"
```

**Important**: Run this script ONCE before calendar operations. If it exits with instructions, follow them, then run again.

---

## API Reference

Base: `https://api.atris.ai/api/integrations`

All requests require: `-H "Authorization: Bearer $TOKEN"`

### Get Token (after bootstrap)
```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
```

### List Events
```bash
# Next 7 days (default)
curl -s "https://api.atris.ai/api/integrations/google-calendar/events" \
  -H "Authorization: Bearer $TOKEN"

# Next N days
curl -s "https://api.atris.ai/api/integrations/google-calendar/events?days=14" \
  -H "Authorization: Bearer $TOKEN"

# Custom date range (ISO 8601)
curl -s "https://api.atris.ai/api/integrations/google-calendar/events?time_min=2026-02-15T00:00:00Z&time_max=2026-02-16T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Today's Events
```bash
curl -s "https://api.atris.ai/api/integrations/google-calendar/events/today" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Single Event
```bash
curl -s "https://api.atris.ai/api/integrations/google-calendar/events/{event_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Create Event
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-calendar/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "summary": "Meeting with Hugo",
    "start": "2026-02-15T14:00:00-08:00",
    "end": "2026-02-15T15:00:00-08:00",
    "description": "Discuss project roadmap",
    "location": "Zoom",
    "attendees": ["hugo@atrismail.com"],
    "timezone": "America/Los_Angeles"
  }'
```

**IMPORTANT:** Use `POST` to create events. Do NOT use `PUT` — that is for updating existing events.

### Update Event
```bash
curl -s -X PUT "https://api.atris.ai/api/integrations/google-calendar/events/{event_id}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "summary": "Updated meeting title",
    "start": "2026-02-15T15:00:00-08:00",
    "end": "2026-02-15T16:00:00-08:00",
    "timezone": "America/Los_Angeles"
  }'
```

### Delete Event
```bash
curl -s -X DELETE "https://api.atris.ai/api/integrations/google-calendar/events/{event_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Check Connection Status
```bash
curl -s "https://api.atris.ai/api/integrations/google-calendar/status" \
  -H "Authorization: Bearer $TOKEN"
```

### Disconnect Google Calendar
```bash
curl -s -X DELETE "https://api.atris.ai/api/integrations/google-calendar" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Workflows

### "What's on my calendar today?"
1. Run bootstrap
2. Get events: `GET /google-calendar/events/today`
3. Display events sorted by start time: time, title, location
4. If no events: "Your calendar is clear today."

### "What's my schedule this week?"
1. Run bootstrap
2. Get events: `GET /google-calendar/events?days=7`
3. Group by day, display each day's events

### "Schedule a meeting with X"
1. Run bootstrap
2. Create event: `POST /google-calendar/events` with summary, start, end, attendees
3. Confirm: "Meeting created! [link]"

### "Do I have any meetings this afternoon?"
1. Run bootstrap
2. Get events: `GET /google-calendar/events/today`
3. Filter events where start time is after 12:00 PM in user's timezone
4. Display matching events or "No meetings this afternoon."

### "When is my next meeting?"
1. Run bootstrap
2. Get events: `GET /google-calendar/events/today`
3. Find the next event after current time
4. Display: "Your next meeting is [title] at [time]" or "No more meetings today."

### "Cancel my 3pm meeting"
1. Run bootstrap
2. List events: `GET /google-calendar/events/today`
3. Find event at 3pm
4. **Confirm with user** before deleting
5. Delete: `DELETE /google-calendar/events/{event_id}`

---

## Display Format

When showing calendar events, use this format:

```
Today's Schedule (Feb 15, 2026)

  9:00 AM - 9:30 AM   Team Standup
                       Google Meet

 10:00 AM - 11:00 AM  Product Review
                       Conference Room B
                       with alice@example.com, bob@example.com

  1:00 PM - 1:30 PM   1:1 with Manager
                       Zoom

3 events today
```

**Rules:**
- Sort by start time
- Show location if available
- Show attendees if available (max 3, then "and N more")
- Use 12-hour format with AM/PM
- For all-day events, show "All day" instead of times

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `Token expired` | AtrisOS session expired | Run `atris login` |
| `Calendar not connected` | OAuth not completed | Re-run bootstrap, complete OAuth flow |
| `401 Unauthorized` | Invalid/expired token | Run `atris login` |
| `400 Calendar not connected` | No calendar credentials | Complete OAuth via bootstrap |
| `429 Rate limited` | Too many requests | Wait 60s, retry |
| `Invalid grant` | Google revoked access | Re-connect calendar via bootstrap |

---

## Security Model

1. **Local token** (`~/.atris/credentials.json`): Your AtrisOS auth token, stored locally with 600 permissions.

2. **Calendar credentials**: Your Google Calendar refresh token is stored **server-side** in AtrisOS encrypted vault. Never stored on your local machine.

3. **Access control**: AtrisOS API enforces that you can only access your own calendar. No cross-user access possible.

4. **OAuth scopes**: Only requests necessary Calendar permissions (read events, manage events).

5. **HTTPS only**: All API communication encrypted in transit.

---

## Quick Reference

```bash
# Setup (one time)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Check connection
curl -s "https://api.atris.ai/api/integrations/google-calendar/status" -H "Authorization: Bearer $TOKEN"

# Today's events
curl -s "https://api.atris.ai/api/integrations/google-calendar/events/today" -H "Authorization: Bearer $TOKEN"
```

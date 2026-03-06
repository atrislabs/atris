---
name: apps
description: View, manage, and trigger Atris apps. Use when user asks about their apps, app status, runs, data, or wants to trigger an app.
version: 1.0.0
tags:
  - apps
  - atris
  - management
---

# Apps

View and manage your Atris apps — status, runs, data, secrets, members.

## Bootstrap

```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)" 2>/dev/null \
  || python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.atris/credentials.json')))['token'])" 2>/dev/null)
if [ -z "$TOKEN" ]; then echo "Not logged in. Run: atris login"; exit 1; fi
echo "Ready."
```

Base URL: `https://api.atris.ai/api/apps`

Auth: `-H "Authorization: Bearer $TOKEN"`

---

## List My Apps

```bash
curl -s "https://api.atris.ai/api/apps" \
  -H "Authorization: Bearer $TOKEN"
```

Returns all apps you own with id, name, slug, description, template, status.

### Filter Apps

```bash
# Template apps only
curl -s "https://api.atris.ai/api/apps?filter=template" \
  -H "Authorization: Bearer $TOKEN"

# Paid apps
curl -s "https://api.atris.ai/api/apps?filter=paid" \
  -H "Authorization: Bearer $TOKEN"

# Free apps
curl -s "https://api.atris.ai/api/apps?filter=free" \
  -H "Authorization: Bearer $TOKEN"
```

---

## App Details

### Get App Status
```bash
curl -s "https://api.atris.ai/api/apps/{slug}/status" \
  -H "Authorization: Bearer $TOKEN"
```

Returns: last run, next run, health, active members.

### Get App Runs
```bash
curl -s "https://api.atris.ai/api/apps/{slug}/runs?limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Single Run
```bash
curl -s "https://api.atris.ai/api/apps/{slug}/runs/{run_id}" \
  -H "Authorization: Bearer $TOKEN"
```

---

## App Data

### Read All Data
```bash
curl -s "https://api.atris.ai/api/apps/{slug}/data" \
  -H "Authorization: Bearer $TOKEN"
```

### Read Specific Collection
```bash
curl -s "https://api.atris.ai/api/apps/{slug}/data/{collection}" \
  -H "Authorization: Bearer $TOKEN"
```

### Push Data In
```bash
curl -s -X POST "https://api.atris.ai/api/apps/{slug}/ingest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection": "leads", "data": {"name": "Acme", "score": 85}}'
```

---

## Secrets

### List Secret Keys (names + storage tier)
```bash
curl -s "https://api.atris.ai/api/apps/{slug}/secrets" \
  -H "Authorization: Bearer $TOKEN"
```

Returns key names and where they're stored:
- `"storage_tier": "cloud"` — encrypted in Atris vault
- `"storage_tier": "local"` — on your machine at `~/.atris/secrets/{slug}/`

### Store Secret (cloud)
```bash
curl -s -X PUT "https://api.atris.ai/api/apps/{slug}/secrets/{key}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-secret-value"}'
```

### Register Local Secret (manifest only)
```bash
curl -s -X POST "https://api.atris.ai/api/apps/{slug}/secrets/{key}/register-local" \
  -H "Authorization: Bearer $TOKEN"
```

No value sent. Just tells the web UI "this key exists on my machine."

### Delete Secret
```bash
curl -s -X DELETE "https://api.atris.ai/api/apps/{slug}/secrets/{key}" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Members

### List App Members
```bash
curl -s "https://api.atris.ai/api/apps/{slug}/members" \
  -H "Authorization: Bearer $TOKEN"
```

### Add Member (agent operator)
```bash
curl -s -X POST "https://api.atris.ai/api/apps/{slug}/members" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "AGENT_ID", "role": "operator"}'
```

### Remove Member
```bash
curl -s -X DELETE "https://api.atris.ai/api/apps/{slug}/members/{agent_id}" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Trigger

### Run App Now
```bash
curl -s -X POST "https://api.atris.ai/api/apps/{slug}/trigger" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trigger_type": "manual"}'
```

---

## App Manifest (for published apps)

```bash
curl -s "https://api.atris.ai/api/apps/{slug}/manifest"
```

No auth needed. Returns name, description, required secrets, schedule.

### Install a Published App

```bash
curl -s -X POST "https://api.atris.ai/api/apps/{slug}/install" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## Workflows

### "What apps do I have?"
1. List apps: `GET /api/apps`
2. Display: name, slug, template, last run status

### "How is my app doing?"
1. Get status: `GET /api/apps/{slug}/status`
2. Get recent runs: `GET /api/apps/{slug}/runs?limit=5`
3. Show: health, last run time, success/failure, output

### "Check my app's secrets"
1. List secrets: `GET /api/apps/{slug}/secrets`
2. Show each key with storage tier (cloud/local)
3. If required secrets are missing, tell the user how to add them

### "Run my app"
1. Trigger: `POST /api/apps/{slug}/trigger`
2. Poll status: `GET /api/apps/{slug}/status` (wait for completion)
3. Show run result: `GET /api/apps/{slug}/runs?limit=1`

---

## Quick Reference

```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# List all my apps
curl -s "https://api.atris.ai/api/apps" -H "Authorization: Bearer $TOKEN"

# App status
curl -s "https://api.atris.ai/api/apps/SLUG/status" -H "Authorization: Bearer $TOKEN"

# Recent runs
curl -s "https://api.atris.ai/api/apps/SLUG/runs?limit=5" -H "Authorization: Bearer $TOKEN"

# Trigger a run
curl -s -X POST "https://api.atris.ai/api/apps/SLUG/trigger" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"trigger_type":"manual"}'

# Read app data
curl -s "https://api.atris.ai/api/apps/SLUG/data" -H "Authorization: Bearer $TOKEN"

# List secrets (with storage tier)
curl -s "https://api.atris.ai/api/apps/SLUG/secrets" -H "Authorization: Bearer $TOKEN"
```

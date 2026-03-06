---
name: create-app
description: Build and deploy an Atris app from a natural language description. Use when users ask to create Atris apps, workflows, or chat apps with setup automation.
version: 1.0.0
tags:
  - atris
  - apps
  - workflow
  - automation
---

# Create App

Build and deploy an Atris app from a natural language description.

## When to Use

User says something like:
- "I want daily analytics from my Mixpanel"
- "Make me a chat app for job screening"
- "Set up a workflow that monitors my app reviews"
- "Build an app that qualifies leads from a CSV"

## What an App Is

An app is a container: data in, agent processes, data out. Three independent parts:

- **App** = the box (storage, API, schedule, auth)
- **Skill** = the brain (what to do with the data)
- **Member** = the operator (the agent that runs it)

Not every app needs all three. A chat widget just needs config. An autonomous workflow needs all three.

## Bootstrap

Get the user's Atris API token:

```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.atris/credentials.json')))['token'])" 2>/dev/null)
fi
if [ -z "$TOKEN" ]; then
  echo "Not logged in. Run: atris login"
  exit 1
fi
echo "Ready."
```

Base URL: `https://api.atris.ai`
Auth header: `Authorization: Bearer $TOKEN`

## Flow

Adapt the flow based on what the user described. Skip steps that don't apply.

### Step 1: Create the App

Ask the user for a name. Generate a slug (lowercase, hyphens, no spaces).

```bash
curl -s -X POST "https://api.atris.ai/api/apps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "APP_NAME",
    "description": "DESCRIPTION",
    "instructions": "SYSTEM_PROMPT",
    "share_token": "SLUG",
    "app_type": "external",
    "access_mode": "private",
    "ui_template": "chat",
    "config": {}
  }'
```

Save the returned `id` as `APP_ID` and `share_token` as `SLUG`.

**Decisions:**
- `access_mode`: `"private"` for personal workflows, `"public"` for shared apps
- `ui_template`: `"chat"` for conversational, omit for headless workflows
- `instructions`: the system prompt if it's a chat app, or a description of purpose for workflows

### Step 2: Store API Keys (if needed)

Only if the workflow needs external API access (Mixpanel, GitHub, Stripe, etc).

Ask the user for each key. **Default to local storage** (keys stay on their machine).

**Option A: Local storage (default, recommended)**

Keys are saved to `~/.atris/secrets/{SLUG}/` on the user's machine. They never leave the machine when using the CLI agent. If using the AI Computer, they're transmitted over TLS but never persisted on Atris infrastructure.

```bash
mkdir -p ~/.atris/secrets/SLUG
```

For each key:
```bash
read -s -p "Enter KEY_NAME: " secret_val
printf '%s' "$secret_val" > ~/.atris/secrets/SLUG/KEY_NAME
chmod 600 ~/.atris/secrets/SLUG/KEY_NAME
unset secret_val
echo "Saved locally."
```

Register the key in the web UI (manifest only — no value sent):
```bash
curl -s -X POST "https://api.atris.ai/api/apps/SLUG/secrets/KEY_NAME/register-local" \
  -H "Authorization: Bearer $TOKEN"
```

Verify (key names only, never values):
```bash
ls ~/.atris/secrets/SLUG/
```

**Option B: Cloud storage (cross-device access)**

If the user needs secrets accessible from any device or the web UI, store in the encrypted cloud vault:

```bash
curl -s -X PUT "https://api.atris.ai/api/apps/SLUG/secrets/KEY_NAME" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "THE_SECRET_VALUE"}'
```

Never log or display the secret value after storing it.

**Always ask the user which storage tier they prefer before storing keys.** Explain: "Local means keys stay on your machine. Cloud means they're encrypted and available from any device."

**Skip this step** if the app doesn't need external API keys (chat apps, simple forms).

### Step 3: Create the Agent + Skill (if needed)

For autonomous workflows, the app needs an agent with a skill that knows what to do.

**3a. Create or pick an agent:**

If the user already has an agent, use it. Otherwise create one:

```bash
curl -s -X POST "https://api.atris.ai/api/agent/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AGENT_NAME",
    "instructions": "AGENT_INSTRUCTIONS",
    "access_mode": "api"
  }'
```

Save the returned `id` as `AGENT_ID`. If access_mode is "api", also save the `api_key` (shown once).

**3b. Write the skill:**

The skill is the logic. Write it as a markdown file that describes what the agent should do. Store it in the agent's file memory:

```bash
curl -s -X POST "https://api.atris.ai/api/agent/AGENT_ID/files" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "skills/APP_SLUG.md",
    "content": "SKILL_CONTENT"
  }'
```

The skill content should include:
- What data to pull and how (API endpoints, auth patterns)
- What analysis to run
- What output to produce
- Where to store results

Example skill for Mixpanel analytics:
```markdown
# Mixpanel Analytics Skill

Pull daily event data from Mixpanel, analyze user segments, report insights.

## Steps
1. Use MIXPANEL_API_KEY to call Mixpanel Export API
2. Pull events from last 24 hours
3. Segment users by: first-generation completion, paid conversion, feature usage
4. Compare against previous day's data (read from app storage)
5. Identify: what grew, what dropped, any anomalies
6. Store results in app data (collection: "daily-analysis")
7. Email summary to owner

## Output Format
- 3-5 bullet points of what changed
- One recommendation
- Raw numbers for verification
```

**3c. Add agent as app member:**

```bash
curl -s -X POST "https://api.atris.ai/api/apps/SLUG/members" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "AGENT_ID", "role": "operator"}'
```

**Skip this step** for chat apps that don't need an autonomous agent.

### Step 4: Set Schedule (if needed)

For apps that run on a schedule:

```bash
curl -s -X POST "https://api.atris.ai/api/scheduled-tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "AGENT_ID",
    "task_type": "pulse",
    "cron_expression": "0 8 * * *",
    "enabled": true
  }'
```

Common schedules:
- `"0 8 * * *"` — daily at 8am UTC
- `"0 */6 * * *"` — every 6 hours
- `"0 9 * * 1"` — weekly Monday 9am UTC

**Skip this step** for on-demand apps (manual trigger only) or chat apps.

### Step 5: Test It

Trigger the first run to verify everything works:

```bash
curl -s -X POST "https://api.atris.ai/api/apps/SLUG/trigger" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trigger_type": "manual"}'
```

Check status:

```bash
curl -s "https://api.atris.ai/api/apps/SLUG/status" \
  -H "Authorization: Bearer $TOKEN"
```

Check run result:

```bash
curl -s "https://api.atris.ai/api/apps/SLUG/runs?limit=1" \
  -H "Authorization: Bearer $TOKEN"
```

If the run succeeded, show the user. If it failed, read the error and fix.

### Step 6: Confirm

Tell the user:
- App name and slug
- What it does
- When it runs (schedule or manual)
- Where output goes (email, API, feed)
- How to check status: `GET /api/apps/SLUG/status`
- How to query data: `GET /api/apps/SLUG/data`

## App Runtime API Reference

All endpoints use the app's `share_token` as `{slug}`.

```
POST   /api/apps/{slug}/trigger          — run the app now
POST   /api/apps/{slug}/ingest           — push data in
POST   /api/apps/{slug}/ingest/batch     — push multiple items
GET    /api/apps/{slug}/data             — read stored data
GET    /api/apps/{slug}/data/{collection} — read specific collection
GET    /api/apps/{slug}/status           — health, last run, next run
GET    /api/apps/{slug}/runs             — execution history
GET    /api/apps/{slug}/runs/{run_id}    — single run details
PUT    /api/apps/{slug}/secrets/{key}    — store an API key (owner only)
GET    /api/apps/{slug}/secrets          — list key names (owner only)
DELETE /api/apps/{slug}/secrets/{key}    — remove a key (owner only)
POST   /api/apps/{slug}/members          — add agent operator
GET    /api/apps/{slug}/members          — list members
DELETE /api/apps/{slug}/members/{agent_id} — remove member
```

## Examples

**"I want daily analytics from Mixpanel"**
→ Steps 1-5. Private app, Mixpanel key stored, agent with analytics skill, daily schedule, email output.

**"Make a chat app for screening candidates"**
→ Steps 1 only. Public app, chat template, instructions define the interview flow. No agent, no schedule, no keys.

**"Set up a webhook that collects app feedback"**
→ Steps 1, 3. Private app, agent processes inbound data. No schedule (webhook-triggered). User posts to `/ingest`, agent analyzes on trigger.

**"Qualify leads from a CSV"**
→ Steps 1-3, 5. Private app, agent with qualification skill. Manual trigger (upload CSV via `/ingest/batch`, then `/trigger`). No schedule.

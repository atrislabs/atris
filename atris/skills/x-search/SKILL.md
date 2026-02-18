---
name: x-search
description: "X/Twitter search via xAI Grok API. Use when user wants to search tweets, monitor topics, find viral posts, or run social listening. Costs 5 credits per search. Triggers on x search, tweet search, twitter search, social listening, revenue intel, viral tweets."
version: 2.0.0
tags:
  - x-search
  - social
  - research
---

# X Search

> Drop this in `~/.claude/skills/x-search/SKILL.md` and Claude Code becomes your X/Twitter intelligence tool.

## Bootstrap (ALWAYS Run First)

Before any X search operation, run this bootstrap to ensure everything is set up:

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

# 4. Quick auth check
STATUS=$(curl -s "https://api.atris.ai/api/me" \
  -H "Authorization: Bearer $TOKEN")

if echo "$STATUS" | grep -q "Token expired\|Not authenticated\|Unauthorized"; then
  echo "Token expired. Please re-authenticate:"
  echo "  Run: atris login --force"
  exit 1
fi

echo "Ready. X Search is available (5 credits per search)."
export ATRIS_TOKEN="$TOKEN"
```

---

## API Reference

Base: `https://api.atris.ai/api/x-search`

All requests require: `-H "Authorization: Bearer $TOKEN"`

### Get Token (after bootstrap)
```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
```

### Search X/Twitter
```bash
curl -s -X POST "https://api.atris.ai/api/x-search/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "\"CRM is dead\" OR \"Salesforce alternative\"",
    "limit": 10
  }'
```

**With date filter** (last N days only):
```bash
curl -s -X POST "https://api.atris.ai/api/x-search/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "AI agents replacing SaaS",
    "limit": 10,
    "days_back": 7
  }'
```

**Response:**
```json
{
  "status": "success",
  "credits_used": 5,
  "credits_remaining": 995,
  "data": {
    "content": "1. @levelsio: AI agents are replacing...",
    "citations": ["https://x.com/levelsio/status/..."],
    "usage": {"prompt_tokens": 200, "completion_tokens": 800}
  }
}
```

### Research a Person
```bash
curl -s -X POST "https://api.atris.ai/api/x-search/research-person" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Leah Bonvissuto",
    "handle": "leahbon",
    "company": "Presentr",
    "context": "Interested in revenue intelligence and AI for GTM"
  }'
```

**Response:**
```json
{
  "status": "success",
  "credits_used": 5,
  "credits_remaining": 990,
  "data": {
    "content": "### 1. Profile\n**Name:** Leah Bonvissuto\n...",
    "citations": ["https://x.com/..."],
    "usage": {"prompt_tokens": 300, "completion_tokens": 1200}
  }
}
```

---

## Workflows

### "Search X for tweets about a topic"
1. Run bootstrap
2. Search: `POST /x-search/search` with `{query, limit}`
3. Display results: tweet text, author, engagement, links

### "Find tweets from the last week about X"
1. Run bootstrap
2. Search with date filter: `POST /x-search/search` with `{query, limit, days_back: 7}`
3. Display results sorted by engagement

### "Research a person before a meeting"
1. Run bootstrap
2. Research: `POST /x-search/research-person` with `{name, handle, company, context}`
3. Display profile, background, talking points

### "Monitor keyword clusters for revenue intel"
1. Run bootstrap
2. Run multiple searches across keyword clusters:
   - `"CRM is dead" OR "Salesforce is dead" OR "HubSpot sucks"`
   - `"revenue operations" (broken OR frustrated OR replacing)`
   - `(founder OR CEO) "tech stack" (consolidating OR ripping out)`
3. Each search costs 5 credits
4. Combine results, rank by engagement, draft replies

### "Find viral tweets in my industry"
1. Run bootstrap
2. Search with engagement filter: `POST /x-search/search` with query including `min_faves:50`
3. Display top tweets sorted by likes/retweets

---

## Query Tips

| Goal | Query Example |
|------|--------------|
| Specific phrase | `"revenue operations"` |
| OR logic | `"CRM is dead" OR "Salesforce alternative"` |
| From a user | `from:levelsio` |
| High engagement | `"AI agents" min_faves:50` |
| Exclude retweets | `"your query" -is:retweet` |
| Multiple keywords | `(founder OR CEO) ("AI adoption" OR "AI native")` |

---

## Billing

- Every search costs **5 credits** (flat)
- 1 credit = $0.01, so 1 search = $0.05
- Research person also costs 5 credits
- Credits are deducted server-side before the search runs
- If insufficient credits, returns `402 Insufficient credits`

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `401 Not authenticated` | Invalid/expired token | Run `atris login` |
| `402 Insufficient credits` | Not enough credits | Purchase credits at atris.ai |
| `502 Search failed` | xAI API issue | Retry in a few seconds |

---

## Quick Reference

```bash
# Setup (one time)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Search tweets
curl -s -X POST "https://api.atris.ai/api/x-search/search" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "AI agents", "limit": 10}'

# Search last 7 days only
curl -s -X POST "https://api.atris.ai/api/x-search/search" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "AI agents", "limit": 10, "days_back": 7}'

# Research a person
curl -s -X POST "https://api.atris.ai/api/x-search/research-person" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "handle": "johndoe", "company": "Acme"}'
```

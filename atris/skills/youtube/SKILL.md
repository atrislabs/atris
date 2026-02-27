---
name: youtube
description: "Process YouTube videos — extract insights, answer questions, store as knowledge. 5 credits per video. Triggers on: youtube, video, process video, watch this, learn from video."
version: 2.1.0
tags:
  - youtube
  - research
  - video
  - learning
---

# YouTube Skill

Process any YouTube video through Gemini's native video API. No transcript scraping — it sees the actual video (visual + audio). 5 credits per video, refunded if processing fails.

## Bootstrap (ALWAYS Run First)

```bash
#!/bin/bash
set -e

# 1. Check atris CLI
if ! command -v atris &> /dev/null; then
  echo "Installing atris CLI..."
  npm install -g atris
fi

# 2. Check login
if [ ! -f ~/.atris/credentials.json ]; then
  echo "Not logged in. Run: atris login"
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

# 4. Auth check
STATUS=$(curl -s "https://api.atris.ai/api/me" \
  -H "Authorization: Bearer $TOKEN")

if echo "$STATUS" | grep -q "Token expired\|Not authenticated\|Unauthorized"; then
  echo "Token expired. Run: atris login --force"
  exit 1
fi

echo "Ready. YouTube skill active (5 credits per video)."
export ATRIS_TOKEN="$TOKEN"
```

---

## API Reference

Base: `https://api.atris.ai/api`
Auth: `-H "Authorization: Bearer $TOKEN"`

### Get Token
```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
```

### Process a Video
```bash
curl -s -X POST "https://api.atris.ai/api/agent/process_youtube" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "youtube_url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "query": "What are the key takeaways?"
  }'
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `youtube_url` | string | yes | Any YouTube URL |
| `query` | string | no | Question to focus the analysis on |
| `agent_id` | string | no | Agent ID to store analysis in its knowledge base |
| `store_as_knowledge` | bool | no | Save to agent's knowledge (requires `agent_id`) |

**Response:**
```json
{
  "status": "success",
  "message": "YouTube video processed successfully",
  "youtube_url": "https://www.youtube.com/watch?v=...",
  "video_analysis": "This video covers...",
  "stored_as_knowledge": false,
  "credits_used": 5,
  "credits_remaining": 95,
  "metadata": {
    "title": "Video Title",
    "channel": "Channel Name"
  }
}
```

### Process + Store as Knowledge
```bash
curl -s -X POST "https://api.atris.ai/api/agent/process_youtube" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "youtube_url": "https://www.youtube.com/watch?v=...",
    "query": "Extract the main arguments and evidence",
    "agent_id": "YOUR_AGENT_ID",
    "store_as_knowledge": true
  }'
```

---

## Workflows

### "Learn from this YouTube video"
1. Run bootstrap
2. Process: `POST /api/agent/process_youtube` with `{youtube_url, query: "What are the key lessons and insights?"}`
3. Display the analysis to the user

### "What does this video say about X?"
1. Run bootstrap
2. Process with focused query: `{youtube_url, query: "What does this say about X?"}`
3. Show the focused analysis

### "Process multiple videos on a topic"
1. Run bootstrap
2. Process each sequentially (each = 5 credits):
```bash
VIDEOS=(
  "https://youtube.com/watch?v=AAA"
  "https://youtube.com/watch?v=BBB"
)

for url in "${VIDEOS[@]}"; do
  echo "Processing: $url"
  curl -s -X POST "https://api.atris.ai/api/agent/process_youtube" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"youtube_url\": \"$url\", \"query\": \"Key insights and takeaways\"}"
  echo ""
done
```
3. Synthesize findings across all videos

### "Save video insights to my agent's memory"
1. Run bootstrap
2. Get your agent ID: `curl -s "https://api.atris.ai/api/agent/my-agents" -H "Authorization: Bearer $TOKEN"`
3. Process with storage: `{youtube_url, agent_id: "...", store_as_knowledge: true}`
4. Agent can now reference these insights in future conversations

---

## How It Works

One Gemini call. The YouTube URL goes directly to Gemini's native multimodal API — it processes the actual video frames and audio, not just a transcript. This means it can describe visuals, read slides, understand demos, and catch things transcripts miss.

---

## Billing

- **5 credits per video** (flat rate, any length)
- Credits deducted before processing
- **Full refund** if Gemini fails or returns an error
- Insufficient credits returns 402 with your current balance

---

## Error Handling

| Error | Meaning | Fix |
|-------|---------|-----|
| `401` | Token expired/invalid | `atris login --force` |
| `402` | Not enough credits | Check balance, purchase at atris.ai |
| `400` | Invalid YouTube URL | Check URL format |
| `502` | Gemini failed | Retry — credits auto-refunded |

---

## Quick Reference

```bash
# Setup (once)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Process a video
curl -s -X POST "https://api.atris.ai/api/agent/process_youtube" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url": "https://youtube.com/watch?v=...", "query": "Summarize this"}'

# Process + store to agent knowledge
curl -s -X POST "https://api.atris.ai/api/agent/process_youtube" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url": "https://youtube.com/watch?v=...", "agent_id": "YOUR_ID", "store_as_knowledge": true}'
```

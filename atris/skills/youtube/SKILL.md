---
name: youtube
description: "Process YouTube videos — extract insights, answer questions, store as knowledge. 5 credits per video. Triggers on: youtube, video, process video, watch this, learn from video."
version: 2.2.0
tags:
  - youtube
  - research
  - video
  - learning
---

# YouTube Skill

Process any YouTube video through Atris transcript-first analysis. The CLI extracts local captions with timestamps when available, sends that transcript to Atris, and falls back to cloud video processing when captions are unavailable or unusable. 5 credits per video, refunded if processing fails.

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
atris youtube process "https://www.youtube.com/watch?v=VIDEO_ID" \
  --query "Create a timestamped outline, claims, examples, takeaways, and action items."
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
    "channel": "Channel Name",
    "duration_seconds": 4459,
    "processing_method": "client_transcript_atris_fast",
    "transcript_source": "client_transcript",
    "transcript_language": "en"
  }
}
```

### Process + Store as Knowledge
```bash
atris youtube process "https://www.youtube.com/watch?v=..." \
  --query "Extract the main arguments and evidence" \
  --agent "YOUR_AGENT_ID" \
  --store
```

---

## Workflows

### "Learn from this YouTube video"
1. Run bootstrap
2. Process: `atris youtube process <url> --query "Create a timestamped outline, claims, examples, takeaways, Atris implications, and next actions."`
3. Display the timestamped analysis to the user

### "What does this video say about X?"
1. Run bootstrap
2. Process with focused query: `atris youtube process <url> --query "What does this say about X?"`
3. Show the focused analysis with timestamps when available

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
  atris youtube process "$url" --query "Key insights and takeaways"
  echo ""
done
```
3. Synthesize findings across all videos with timestamped evidence

### "Save video insights to my agent's memory"
1. Run bootstrap
2. Get your agent ID: `atris agent`
3. Process with storage: `atris youtube process <url> --agent "..." --store`
4. Agent can now reference these insights in future conversations

---

## Output Contract

Default output should be useful for retrieval and action:

```text
metadata
timestamped outline
core claims with confidence
memorable examples
actionable takeaways
Atris/product implications
next actions
```

Every important insight should carry a timestamp when the transcript provides one. Treat native-video/cloud fallback output as less auditable unless it includes equivalent time anchors.

## How It Works

`atris youtube` first tries local transcript extraction with `yt-dlp`. It sends timestamped `transcript_text` to `/agent/process_youtube` with `cache_transcript=false`. If local transcript processing fails with a retryable error, it falls back to cloud video processing. Use `--json` to inspect `metadata.processing_method` and `metadata.transcript_source`.

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
| `502` | Transcript or cloud processing failed | Retry — credits auto-refunded when backend fails |

---

## Quick Reference

```bash
# Setup (once)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Process a video
atris youtube process "https://youtube.com/watch?v=..." --query "Create a timestamped outline and action brief"

# Process + store to agent knowledge
atris youtube process "https://youtube.com/watch?v=..." --agent "YOUR_ID" --store
```

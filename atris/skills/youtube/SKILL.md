---
name: youtube
description: "YouTube discovery and learning. Use atris youtube search QUERY to get free youtu.be links (local ytsearch/yt-dlp, zero credits). Use atris youtube search --paid QUERY to buy watch permalinks from Atris (5 credits, login required). A YouTube link in any message routes here: run atris youtube notes URL FIRST (free, about 30s, quotes verified). Never summarize a video from model memory. Use atris youtube process only to store it as queryable knowledge (5 credits). Triggers on: youtube search, find videos, paid youtube search, any youtube.com or youtu.be link, youtube, video, watch this, notes on this."
version: 2.7.0
tags:
  - youtube
  - research
  - video
  - learning
---

# YouTube Skill

Three rails. Pick before running anything:

- **Search / discovery (free)** → `atris youtube search "<query>"`. Local ytsearch or yt-dlp `ytsearchN:`. Returns title, channel, duration, views, upload_date, and a `youtu.be` link. Zero credits. Use this to *get* video links; do not call process until the user picks one.
- **Paid search (5 credits)** → `atris youtube search --paid "<query>"`. Posts `/youtube/search` with the stored token or a youtube-scope agent mint. Prints watch permalinks, titles, and credits. Use this when the customer wants to buy permalinks the same way as `atris x-search`. Do not replace free search with this.
- **Notes / learning (free)** → `atris youtube notes <url>`. Local captions + a fast engine, about 30 seconds, quotes verified against the transcript. Use when the goal is to learn from a video you already have.
- **Process / product (5 credits)** → `atris youtube process <url>`. Credits-billed cloud knowledge store. Use when a customer/agent needs the video stored as Atris knowledge.

If the user says "find videos", "search youtube", or "get youtube links" → search. If they say "learn from", "notes on", "alpha", or "rabbit hole" → notes. If they say "process", "store", "add to knowledge" → process.

Never summarize a video from model memory; that is fabrication.

## Bootstrap (ALWAYS Run First)

```bash
#!/bin/bash
set -e

# 1. Check atris CLI
if ! command -v atris &> /dev/null; then
  echo "Installing atris CLI..."
  npm install -g atris
fi

# 2. Optional login (required only for process / credits)
if [ ! -f ~/.atris/credentials.json ]; then
  echo "Not logged in. Search and notes still work. Process needs: atris login"
fi

# 3. Extract token when present
if [ -f ~/.atris/credentials.json ]; then
  if command -v node &> /dev/null; then
    TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
  elif command -v python3 &> /dev/null; then
    TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.atris/credentials.json')))['token'])")
  elif command -v jq &> /dev/null; then
    TOKEN=$(jq -r '.token' ~/.atris/credentials.json)
  fi
  export ATRIS_TOKEN="$TOKEN"
fi

echo "Ready. YouTube skill active (search + notes free; process 5 credits)."
```

---

## Search videos (free)

```bash
atris youtube search "MCP agents 2026"
atris youtube search "MCP agents" --limit 10
atris youtube search "MCP agents" --json
```

Uses `ytsearch` on PATH when present, else bundled `scripts/det/ytsearch`, else `yt-dlp --flat-playlist --print` with `ytsearchN:`. No credits. No `/agent/process_youtube` call.

## Paid search (5 credits)

```bash
atris youtube search --paid "MCP agents 2026"
atris youtube search --paid "MCP agents" --limit 10
```

Requires login. Uses the stored token, or mints a youtube-scope agent token from disk the same way as `atris youtube process` and `atris x-search`. Never `/auth/cli`. Prints `title | watch permalink` plus credits. Empty or failed searches refund.

Line contract:

```text
title | channel | duration | views | upload_date | https://youtu.be/ID
```

`upload_date` is `YYYYMMDD` (or `NA`) so callers can apply a freshness gate (for example last 6 weeks). After the user picks a URL, run notes (free) or process (5 credits).

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
  --query "Create an outline, claims, examples, takeaways, and action items."
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

### "Find YouTube videos about X"
1. Search: `atris youtube search "X" --limit 10`
2. Show title, channel, duration, views, upload_date, and the youtu.be link
3. Stop. Let the user pick. Do not auto-process.

### "Learn from this YouTube video"
1. Run bootstrap
2. Notes first: `atris youtube notes <url>`
3. Display the analysis as flowing prose: ideas and who said them, never timecodes. Timestamps stay in the stored notes file for verification, not in the reply.

### "What does this video say about X?"
1. Run bootstrap
2. Notes or process with focused query: `atris youtube process <url> --query "What does this say about X?"`
3. Show the focused analysis as prose; cite the speaker, not the clock

### "Process multiple videos on a topic"
1. Search to discover links (free), or use URLs the user already has
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
3. Synthesize findings across all videos; attribute ideas to speakers and videos, keep timecodes out of the reply

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
outline (flowing, idea-first)
core claims with confidence
memorable examples
actionable takeaways
Atris/product implications
next actions
```

Two layers, never mixed. The reply the person reads is flowing prose: ideas, speakers, quotes, no timecodes, nothing that reads like a stopwatch. The stored notes file keeps timestamps beside each claim so verification stays possible; that receipt layer never leaks into the reply. Treat native-video/cloud fallback output as less auditable unless the stored file includes equivalent time anchors.

## How It Works

`atris youtube search` shells to local ytsearch/yt-dlp and never hits the Atris API.

`atris youtube search --paid` posts `{query, limit}` to `/youtube/search` with bearer auth. Agent tokens need the youtube scope.

`atris youtube` process first tries local transcript extraction with `yt-dlp`. It sends timestamped `transcript_text` to `/agent/process_youtube` with `cache_transcript=false`. If local transcript processing fails with a retryable error, it falls back to cloud video processing. Use `--json` to inspect `metadata.processing_method` and `metadata.transcript_source`.

---

## Billing

- **Search: 0 credits** (local discovery)
- **Paid search: 5 credits** (`--paid`; refund on empty or fail)
- **Notes: 0 credits** (local captions + engine)
- **Process: 5 credits per video** (flat rate, any length)
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
| `502` | Transcript or cloud processing failed | Retry; credits auto-refunded when backend fails |
| search exit 2 | ytsearch/yt-dlp missing or no results | Install yt-dlp, or put ytsearch on PATH |
| search 429 | YouTube rate-limited local search | serve last same-query free rows if younger than one hour; otherwise retry later; do not use --paid |

---

## Quick Reference

```bash
# Setup (once)
npm install -g atris && atris login

# Free: discover videos
atris youtube search "MCP agents 2026"
atris youtube search "MCP agents" --limit 10

# Paid: watch permalinks from Atris (5 credits)
atris youtube search --paid "MCP agents 2026"

# Free: notes on a URL you already have
atris youtube notes "https://youtu.be/VIDEO_ID"

# Get token (process only)
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Process a video (5 credits)
atris youtube process "https://youtube.com/watch?v=..." --query "Create a outline (flowing, idea-first) and action brief"

# Process + store to agent knowledge
atris youtube process "https://youtube.com/watch?v=..." --agent "YOUR_ID" --store
```

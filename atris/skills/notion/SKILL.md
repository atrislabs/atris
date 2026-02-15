---
name: notion
description: Notion integration via AtrisOS API. Search pages, read/create/update pages, query databases, manage blocks and comments. Use when user asks about Notion, pages, databases, wikis, or docs.
version: 1.0.0
tags:
  - notion
  - backend
  - productivity
---

# Notion Agent

> Drop this in `~/.claude/skills/notion/SKILL.md` and Claude Code becomes your Notion assistant.

## Bootstrap (ALWAYS Run First)

Before any Notion operation, run this bootstrap to ensure everything is set up:

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

# 4. Check Notion connection status
STATUS=$(curl -s "https://api.atris.ai/api/integrations/notion/status" \
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
  echo "Notion not connected. Getting authorization URL..."
  AUTH=$(curl -s -X POST "https://api.atris.ai/api/integrations/notion/start" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"return_url":"https://atris.ai/dashboard/settings"}')

  if command -v node &> /dev/null; then
    URL=$(node -e "try{console.log(JSON.parse('$AUTH').auth_url||'')}catch(e){console.log('')}")
  elif command -v python3 &> /dev/null; then
    URL=$(echo "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auth_url', ''))")
  else
    URL=$(echo "$AUTH" | jq -r '.auth_url // empty')
  fi

  echo ""
  echo "Open this URL to connect your Notion:"
  echo "$URL"
  echo ""
  echo "After authorizing, run your command again."
  exit 0
fi

echo "Ready. Notion is connected."
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

## Search

### Search Pages & Databases
```bash
curl -s "https://api.atris.ai/api/integrations/notion/search?q=meeting+notes&page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

**Filter by type:**
```bash
# Only pages
curl -s "https://api.atris.ai/api/integrations/notion/search?q=roadmap&filter_type=page" \
  -H "Authorization: Bearer $TOKEN"

# Only databases
curl -s "https://api.atris.ai/api/integrations/notion/search?q=tasks&filter_type=database" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Pages

### Get a Page
```bash
curl -s "https://api.atris.ai/api/integrations/notion/pages/{page_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Create a Page (under a page)
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/pages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "parent_id": "PARENT_PAGE_ID",
    "parent_type": "page_id",
    "title": "Meeting Notes - Feb 14"
  }'
```

### Create a Page (in a database)
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/pages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "parent_id": "DATABASE_ID",
    "parent_type": "database_id",
    "title": "New Task",
    "properties": {
      "Status": {"select": {"name": "In Progress"}},
      "Priority": {"select": {"name": "High"}}
    }
  }'
```

### Create a Page with Content
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/pages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "parent_id": "PARENT_PAGE_ID",
    "parent_type": "page_id",
    "title": "Project Brief",
    "children": [
      {
        "object": "block",
        "type": "heading_2",
        "heading_2": {"rich_text": [{"type": "text", "text": {"content": "Overview"}}]}
      },
      {
        "object": "block",
        "type": "paragraph",
        "paragraph": {"rich_text": [{"type": "text", "text": {"content": "This project aims to..."}}]}
      },
      {
        "object": "block",
        "type": "bulleted_list_item",
        "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "Goal 1: Ship MVP"}}]}
      }
    ]
  }'
```

### Update a Page
```bash
curl -s -X PATCH "https://api.atris.ai/api/integrations/notion/pages/{page_id}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "Status": {"select": {"name": "Done"}}
    }
  }'
```

### Archive a Page
```bash
curl -s -X PATCH "https://api.atris.ai/api/integrations/notion/pages/{page_id}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"archived": true}'
```

---

## Databases

### Get Database Schema
```bash
curl -s "https://api.atris.ai/api/integrations/notion/databases/{database_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Query a Database
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/databases/{database_id}/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"page_size": 20}'
```

**With filters:**
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/databases/{database_id}/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "property": "Status",
      "select": {"equals": "In Progress"}
    },
    "sorts": [
      {"property": "Created", "direction": "descending"}
    ],
    "page_size": 50
  }'
```

### Create a Database
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/databases" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "parent_page_id": "PAGE_ID",
    "title": "Task Tracker",
    "properties": {
      "Name": {"title": {}},
      "Status": {"select": {"options": [{"name": "To Do"}, {"name": "In Progress"}, {"name": "Done"}]}},
      "Priority": {"select": {"options": [{"name": "High"}, {"name": "Medium"}, {"name": "Low"}]}},
      "Due Date": {"date": {}}
    }
  }'
```

---

## Blocks (Page Content)

### Read Page Content
```bash
curl -s "https://api.atris.ai/api/integrations/notion/blocks/{page_id}/children?page_size=50" \
  -H "Authorization: Bearer $TOKEN"
```

### Append Content to a Page
```bash
curl -s -X PATCH "https://api.atris.ai/api/integrations/notion/blocks/{page_id}/children" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "children": [
      {
        "object": "block",
        "type": "paragraph",
        "paragraph": {"rich_text": [{"type": "text", "text": {"content": "Added via Atris!"}}]}
      }
    ]
  }'
```

### Delete a Block
```bash
curl -s -X DELETE "https://api.atris.ai/api/integrations/notion/blocks/{block_id}" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Users

### List Workspace Users
```bash
curl -s "https://api.atris.ai/api/integrations/notion/users" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Integration Info
```bash
curl -s "https://api.atris.ai/api/integrations/notion/me" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Comments

### Get Comments on a Page
```bash
curl -s "https://api.atris.ai/api/integrations/notion/comments/{page_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Add a Comment
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/comments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "parent_id": "PAGE_ID",
    "text": "This looks great! Approved."
  }'
```

### Reply to a Discussion
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/notion/comments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "parent_id": "PAGE_ID",
    "text": "Thanks for the feedback!",
    "discussion_id": "DISCUSSION_ID"
  }'
```

---

## Workflows

### "Search my Notion for X"
1. Run bootstrap
2. Search: `GET /notion/search?q=X`
3. Display: title, type (page/database), last edited

### "What's in my task database?"
1. Run bootstrap
2. Search databases: `GET /notion/search?q=tasks&filter_type=database`
3. Query: `POST /notion/databases/{id}/query` with filters
4. Display rows with properties

### "Create a page with notes"
1. Run bootstrap
2. Search for parent page: `GET /notion/search?q=parent+name&filter_type=page`
3. Create page: `POST /notion/pages` with title + children blocks
4. Confirm: "Page created!" with link

### "Add a row to a database"
1. Run bootstrap
2. Get database schema: `GET /notion/databases/{id}` (to see property names/types)
3. Create page in database: `POST /notion/pages` with `parent_type=database_id` and matching properties
4. Confirm with row details

### "Read a page"
1. Run bootstrap
2. Get page metadata: `GET /notion/pages/{id}`
3. Get page content: `GET /notion/blocks/{id}/children`
4. Display title + content blocks

### "Update task status"
1. Run bootstrap
2. Find the task: search or query database
3. Update: `PATCH /notion/pages/{id}` with new property values
4. Confirm the change

---

## Block Types Reference

Common block types for creating content:

| Type | Key | Rich text field |
|------|-----|----------------|
| Paragraph | `paragraph` | `rich_text` |
| Heading 1 | `heading_1` | `rich_text` |
| Heading 2 | `heading_2` | `rich_text` |
| Heading 3 | `heading_3` | `rich_text` |
| Bullet list | `bulleted_list_item` | `rich_text` |
| Numbered list | `numbered_list_item` | `rich_text` |
| To-do | `to_do` | `rich_text` + `checked` |
| Code | `code` | `rich_text` + `language` |
| Quote | `quote` | `rich_text` |
| Divider | `divider` | (none) |
| Callout | `callout` | `rich_text` + `icon` |

---

## Important Notes

- **Notion tokens don't expire** — once connected, it stays connected
- **Page IDs**: Notion uses UUIDs like `12345678-abcd-1234-abcd-123456789abc`. You can get them from URLs or search results
- **Database pages**: When adding rows to a database, the "page" properties must match the database schema
- **Content = Blocks**: A page's visible content is a list of blocks. Use the blocks endpoint to read/write content
- **Search scope**: Only pages/databases shared with the Atris integration are visible

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `Token expired` | AtrisOS session expired | Run `atris login` |
| `Notion not connected` | OAuth not completed | Re-run bootstrap |
| `401 Unauthorized` | Invalid/expired token | Run `atris login` |
| `object_not_found` | Page/database not shared with integration | Share the page with the Atris integration in Notion |
| `validation_error` | Bad request format | Check property names match database schema |
| `restricted_resource` | No access to resource | Share with Atris integration in Notion settings |

---

## Security Model

1. **Local token** (`~/.atris/credentials.json`): Your AtrisOS auth token, stored locally.
2. **Notion credentials**: Access token stored **server-side** in AtrisOS encrypted vault.
3. **Access control**: AtrisOS API enforces that you can only access your own Notion.
4. **Scoped access**: Only pages/databases explicitly shared with the Atris integration are accessible.
5. **HTTPS only**: All API communication encrypted in transit.

---

## Quick Reference

```bash
# Setup (one time)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Check connection
curl -s "https://api.atris.ai/api/integrations/notion/status" -H "Authorization: Bearer $TOKEN"

# Search
curl -s "https://api.atris.ai/api/integrations/notion/search?q=meeting" -H "Authorization: Bearer $TOKEN"

# Read a page
curl -s "https://api.atris.ai/api/integrations/notion/pages/PAGE_ID" -H "Authorization: Bearer $TOKEN"

# Read page content
curl -s "https://api.atris.ai/api/integrations/notion/blocks/PAGE_ID/children" -H "Authorization: Bearer $TOKEN"

# Create a page
curl -s -X POST "https://api.atris.ai/api/integrations/notion/pages" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"parent_id":"PAGE_ID","parent_type":"page_id","title":"New Page"}'

# Query a database
curl -s -X POST "https://api.atris.ai/api/integrations/notion/databases/DB_ID/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"page_size":20}'

# List users
curl -s "https://api.atris.ai/api/integrations/notion/users" -H "Authorization: Bearer $TOKEN"
```

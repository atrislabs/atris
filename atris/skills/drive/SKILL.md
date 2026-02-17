---
name: drive
description: Google Drive integration via AtrisOS API. Browse, search, read, upload files and work with Google Sheets. Use when user asks about Drive, files, docs, sheets, or spreadsheets.
version: 1.1.0
tags:
  - drive
  - backend
  - google-drive
  - sheets
---

# Drive Agent

> Drop this in `~/.claude/skills/drive/SKILL.md` and Claude Code becomes your Google Drive assistant.

## Bootstrap (ALWAYS Run First)

Before any Drive operation, run this bootstrap to ensure everything is set up:

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

# 4. Check Google Drive connection status
STATUS=$(curl -s "https://api.atris.ai/api/integrations/google-drive/status" \
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
  echo "Google Drive not connected. Getting authorization URL..."
  AUTH=$(curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/start" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}')

  if command -v node &> /dev/null; then
    URL=$(node -e "try{console.log(JSON.parse('$AUTH').auth_url||'')}catch(e){console.log('')}")
  elif command -v python3 &> /dev/null; then
    URL=$(echo "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auth_url', ''))")
  else
    URL=$(echo "$AUTH" | jq -r '.auth_url // empty')
  fi

  echo ""
  echo "Open this URL to connect your Google Drive:"
  echo "$URL"
  echo ""
  echo "After authorizing, run your command again."
  exit 0
fi

echo "Ready. Google Drive is connected."
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

### List Shared Drives
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/shared-drives" \
  -H "Authorization: Bearer $TOKEN"
```

Returns all shared/team drives the user has access to with `id` and `name`.

### List Files
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/files?page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

**List files in a folder:**
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/files?folder_id=FOLDER_ID&page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

**List files in a shared drive:**
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/files?shared_drive_id=DRIVE_ID&page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

**NOTE:** All file operations (list, search, get, download, export) automatically include shared drive files. Use `shared_drive_id` only to scope results to a specific shared drive.

### Search Files
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/search?q=quarterly+report&page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

Simple queries search by file name. For advanced queries, use Drive query syntax:
- `name contains 'budget'` — name search
- `mimeType = 'application/vnd.google-apps.spreadsheet'` — only sheets
- `mimeType = 'application/vnd.google-apps.document'` — only docs
- `modifiedTime > '2026-01-01'` — recently modified

### Get File Metadata
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/files/{file_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Download File
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/download" \
  -H "Authorization: Bearer $TOKEN"
```

Returns base64-encoded content. For Google Docs/Sheets/Slides, use export instead.

### Export Google Docs/Sheets/Slides
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/export?mime_type=text/plain" \
  -H "Authorization: Bearer $TOKEN"
```

**Export formats:**
- `text/plain` — plain text (default, good for Docs)
- `text/html` — HTML
- `application/pdf` — PDF
- `text/csv` — CSV (for Sheets)

### Upload File
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "notes.txt",
    "content": "File content here",
    "mime_type": "text/plain"
  }'
```

**Upload to a specific folder:**
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "report.txt",
    "content": "File content here",
    "mime_type": "text/plain",
    "folder_id": "FOLDER_ID"
  }'
```

---

## Google Sheets

Full read/write access to Google Sheets.

### Get Spreadsheet Info
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/sheets/{spreadsheet_id}" \
  -H "Authorization: Bearer $TOKEN"
```

Returns sheet names, title, and metadata.

### Read Cells
```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/sheets/{spreadsheet_id}/values?range=Sheet1" \
  -H "Authorization: Bearer $TOKEN"
```

**Range uses A1 notation:**
- `Sheet1` — entire sheet
- `Sheet1!A1:D10` — specific range
- `Sheet1!A:A` — entire column A
- `Sheet1!1:1` — entire row 1

### Update Cells
```bash
curl -s -X PUT "https://api.atris.ai/api/integrations/google-drive/sheets/{spreadsheet_id}/values" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "range": "Sheet1!A1:B2",
    "values": [
      ["Name", "Score"],
      ["Alice", 95]
    ]
  }'
```

### Append Rows
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/sheets/{spreadsheet_id}/append" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "range": "Sheet1",
    "values": [
      ["Bob", 88],
      ["Carol", 92]
    ]
  }'
```

---

## Workflows

### "Find a file in my Drive"
1. Run bootstrap
2. Search: `GET /google-drive/search?q=QUERY`
3. Display: name, type, modified date for each result

### "Read a Google Doc"
1. Run bootstrap
2. Search for the doc: `GET /google-drive/search?q=DOC_NAME`
3. Export as text: `GET /google-drive/files/{id}/export?mime_type=text/plain`
4. Display content

### "Read a spreadsheet"
1. Run bootstrap
2. Search for the sheet: `GET /google-drive/search?q=SHEET_NAME`
3. Get sheet info: `GET /google-drive/sheets/{id}` (to see sheet names)
4. Read values: `GET /google-drive/sheets/{id}/values?range=Sheet1`
5. Display as a table

### "Add rows to a spreadsheet"
1. Run bootstrap
2. Find the sheet
3. Read current data to understand the columns: `GET /google-drive/sheets/{id}/values?range=Sheet1!1:1`
4. **Show user what will be appended, get approval**
5. Append: `POST /google-drive/sheets/{id}/append`

### "Browse a shared drive"
1. Run bootstrap
2. List shared drives: `GET /google-drive/shared-drives`
3. Display drive names and IDs
4. List files in chosen drive: `GET /google-drive/files?shared_drive_id=DRIVE_ID`

### "Find a file across all drives"
1. Run bootstrap
2. Search: `GET /google-drive/search?q=QUERY` (automatically searches My Drive + all shared drives)
3. Display results

### "Upload a file to Drive"
1. Run bootstrap
2. Read the local file content
3. **Confirm with user**: "Upload {filename} to Drive?"
4. Upload: `POST /google-drive/files` with `{name, content, mime_type}`

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `Token expired` | AtrisOS session expired | Run `atris login` |
| `Google Drive not connected` | OAuth not completed | Re-run bootstrap |
| `401 Unauthorized` | Invalid/expired token | Run `atris login` |
| `400 Drive not connected` | No Drive credentials | Complete OAuth via bootstrap |
| `429 Rate limited` | Too many requests | Wait 60s, retry |
| `Invalid grant` | Google revoked access | Re-connect via bootstrap |

---

## Security Model

1. **Local token** (`~/.atris/credentials.json`): Your AtrisOS auth token, stored locally with 600 permissions.
2. **Drive credentials**: Google Drive refresh token is stored **server-side** in AtrisOS encrypted vault.
3. **Access control**: AtrisOS API enforces that you can only access your own Drive.
4. **OAuth scopes**: Only requests necessary Drive permissions (read, write files).
5. **HTTPS only**: All API communication encrypted in transit.

---

## Quick Reference

```bash
# Setup (one time)
npm install -g atris && atris login

# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Check connection
curl -s "https://api.atris.ai/api/integrations/google-drive/status" -H "Authorization: Bearer $TOKEN"

# List shared drives
curl -s "https://api.atris.ai/api/integrations/google-drive/shared-drives" -H "Authorization: Bearer $TOKEN"

# List files (includes shared drive files)
curl -s "https://api.atris.ai/api/integrations/google-drive/files" -H "Authorization: Bearer $TOKEN"

# Search files
curl -s "https://api.atris.ai/api/integrations/google-drive/search?q=budget" -H "Authorization: Bearer $TOKEN"

# Read a Google Doc as text
curl -s "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/export?mime_type=text/plain" -H "Authorization: Bearer $TOKEN"

# Read a spreadsheet
curl -s "https://api.atris.ai/api/integrations/google-drive/sheets/{id}/values?range=Sheet1" -H "Authorization: Bearer $TOKEN"

# Append rows to a sheet
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/sheets/{id}/append" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"range":"Sheet1","values":[["Alice",95]]}'

# Upload a file
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"notes.txt","content":"Hello world","mime_type":"text/plain"}'
```

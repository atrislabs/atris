---
name: drive
description: Google Drive integration via AtrisOS API. Full file management (upload, copy, share, move, delete), Google Docs (create, edit, format, templates), Google Sheets (read, write, format, charts). Use when user asks about Drive, files, docs, sheets, or spreadsheets.
version: 2.0.0
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

### Update Existing File
```bash
curl -s -X PUT "https://api.atris.ai/api/integrations/google-drive/files/{file_id}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Updated file content here",
    "mime_type": "text/plain"
  }'
```

**Update content and rename:**
```bash
curl -s -X PUT "https://api.atris.ai/api/integrations/google-drive/files/{file_id}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "New content",
    "mime_type": "text/plain",
    "name": "renamed-file.txt"
  }'
```

### Delete / Trash File
```bash
# Move to trash (recoverable)
curl -s -X DELETE "https://api.atris.ai/api/integrations/google-drive/files/{file_id}?trash=true" \
  -H "Authorization: Bearer $TOKEN"

# Permanently delete (irreversible)
curl -s -X DELETE "https://api.atris.ai/api/integrations/google-drive/files/{file_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Copy File
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/copy" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Copy of Document", "folder_id": "OPTIONAL_FOLDER_ID"}'
```

Works with Docs, Sheets, Slides — creates a full copy.

### Share File
```bash
# Share with a specific user
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/share" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "role": "writer", "notify": true}'

# Share with anyone who has the link
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/share" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"anyone": true, "role": "reader"}'
```

Roles: `reader`, `writer`, `commenter`

### Create Folder
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/folders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Project Files", "parent_id": "OPTIONAL_PARENT_FOLDER_ID"}'
```

### Move File
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/move" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"new_parent_id": "TARGET_FOLDER_ID"}'
```

### Pagination

List and search endpoints return `next_page_token` when there are more results. Pass it to get the next page:

```bash
curl -s "https://api.atris.ai/api/integrations/google-drive/files?page_size=20&page_token=NEXT_PAGE_TOKEN" \
  -H "Authorization: Bearer $TOKEN"
```

Works on: `/files`, `/search`, `/shared-drives`

---

## Google Docs

Native Google Docs creation and editing. Uses the same Drive OAuth connection.

### List Google Docs
```bash
curl -s "https://api.atris.ai/api/integrations/google-docs/documents?page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Create a New Google Doc
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-docs/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Q1 2026 Report"}'
```

Returns `documentId` and `url` (direct link to edit in browser).

### Read a Google Doc
```bash
curl -s "https://api.atris.ai/api/integrations/google-docs/documents/{document_id}" \
  -H "Authorization: Bearer $TOKEN"
```

Returns full document structure (body, paragraphs, text runs, styles).

### Insert Text into a Doc
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-docs/documents/{document_id}/batch-update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {
        "insertText": {
          "location": {"index": 1},
          "text": "Hello, this is the first paragraph.\n\nSecond paragraph here.\n"
        }
      }
    ]
  }'
```

**Text is inserted at a character index.** Index 1 = start of document body. Newlines create paragraphs.

### Replace Placeholders in a Doc Template
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-docs/documents/{document_id}/batch-update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {
        "replaceAllText": {
          "containsText": {"text": "{{client_name}}", "matchCase": true},
          "replaceText": "Acme Corp"
        }
      },
      {
        "replaceAllText": {
          "containsText": {"text": "{{date}}", "matchCase": true},
          "replaceText": "March 5, 2026"
        }
      }
    ]
  }'
```

### Format Text (Bold, Italic, Font Size, Color)
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-docs/documents/{document_id}/batch-update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {
        "updateTextStyle": {
          "range": {"startIndex": 1, "endIndex": 20},
          "textStyle": {"bold": true, "fontSize": {"magnitude": 18, "unit": "PT"}},
          "fields": "bold,fontSize"
        }
      }
    ]
  }'
```

### Insert a Table
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-docs/documents/{document_id}/batch-update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {
        "insertTable": {
          "rows": 3,
          "columns": 2,
          "location": {"index": 1}
        }
      }
    ]
  }'
```

### Export Doc as PDF
```bash
curl -s "https://api.atris.ai/api/integrations/google-docs/documents/{document_id}/export" \
  -H "Authorization: Bearer $TOKEN"
```

Returns base64-encoded PDF.

### Export Doc as Plain Text
```bash
curl -s "https://api.atris.ai/api/integrations/google-docs/documents/{document_id}/text" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Google Sheets

Full read/write access to Google Sheets.

### Create a Spreadsheet
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/sheets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Q1 Revenue Tracker"}'
```

Returns `spreadsheetId` and `url` (direct link to edit in browser).

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

### Format Cells (batchUpdate)

Apply formatting, merges, conditional formatting, charts, and other structural changes.

```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/sheets/{spreadsheet_id}/batchUpdate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {
        "repeatCell": {
          "range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1},
          "cell": {
            "userEnteredFormat": {
              "textFormat": {"bold": true},
              "backgroundColor": {"red": 0.9, "green": 0.9, "blue": 0.9}
            }
          },
          "fields": "userEnteredFormat(textFormat,backgroundColor)"
        }
      }
    ]
  }'
```

**Common request types:**
- `repeatCell` — format a range (bold, colors, font size, alignment)
- `mergeCells` — merge a range into one cell
- `updateBorders` — add borders to cells
- `autoResizeDimensions` — auto-fit column widths
- `addConditionalFormatRule` — highlight cells based on rules
- `addChart` — embed a chart
- `addSheet` / `deleteSheet` — manage sheets/tabs
- `sortRange` — sort rows by a column

**Range format:** `{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 3}` — sheetId 0 = first tab, indices are 0-based.

**Color format:** RGB floats 0-1, e.g. `{"red": 0.2, "green": 0.6, "blue": 1.0}`

You can send multiple requests in one call — they execute in order.

---

## Workflows

### "Create a Google Doc with content"
1. Run bootstrap
2. Create doc: `POST /google-docs/documents` with `{"title": "..."}`
3. Insert text: `POST /google-docs/documents/{id}/batch-update` with `insertText` requests
4. Return the edit URL to user

### "Fill a doc template"
1. Run bootstrap
2. Copy template: `POST /files/{template_id}/copy` with `{"name": "Client Proposal"}`
3. Replace placeholders: `POST /google-docs/documents/{new_id}/batch-update` with `replaceAllText` requests
4. Share if needed: `POST /files/{id}/share`
5. Return URL

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

### "Format a spreadsheet"
1. Run bootstrap
2. Find the sheet, get its `spreadsheetId`
3. Build requests array — bold headers, colors, borders, auto-resize, etc.
4. **Show user what formatting will be applied, get approval**
5. Apply: `POST /google-drive/sheets/{id}/batchUpdate` with `{"requests": [...]}`

### "Create a spreadsheet with data"
1. Run bootstrap
2. Create: `POST /google-drive/sheets` with `{"title": "..."}`
3. Write headers + data: `PUT /google-drive/sheets/{id}/values` with range + values
4. Format headers: `POST /google-drive/sheets/{id}/batchUpdate` (bold, background color)
5. Return the URL

### "Share a file"
1. Run bootstrap
2. Find the file
3. **Ask user**: share with specific email or anyone with link?
4. Share: `POST /google-drive/files/{id}/share`

### "Organize files into folders"
1. Run bootstrap
2. Create folder: `POST /google-drive/folders` with `{"name": "..."}`
3. Move files: `POST /google-drive/files/{id}/move` with `{"new_parent_id": "FOLDER_ID"}`

### "Copy a template"
1. Run bootstrap
2. Find the template file
3. Copy: `POST /google-drive/files/{id}/copy` with `{"name": "New Name"}`
4. If it's a Doc, replace placeholders via `/google-docs/documents/{new_id}/batch-update`
5. Share if needed

### "Delete files"
1. Run bootstrap
2. Find the files
3. **Confirm with user** — show file names
4. Trash (recoverable): `DELETE /google-drive/files/{id}?trash=true`
5. Or permanent delete: `DELETE /google-drive/files/{id}`

### "Upload a file to Drive"
1. Run bootstrap
2. Read the local file content
3. **Confirm with user**: "Upload {filename} to Drive?"
4. Upload: `POST /google-drive/files` with `{name, content, mime_type}`

### "Edit a file on Drive"
1. Run bootstrap
2. Find the file: `GET /google-drive/search?q=FILENAME`
3. Read current content: `GET /google-drive/files/{id}/export?mime_type=text/plain`
4. Make edits
5. **Show user the changes for approval**
6. Update: `PUT /google-drive/files/{id}` with `{content, mime_type}`

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

# Upload a new file
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"notes.txt","content":"Hello world","mime_type":"text/plain"}'

# Create a folder
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/folders" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Project Files"}'

# Copy a file
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/copy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Copy of Doc"}'

# Share with email
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/share" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","role":"writer"}'

# Move file to folder
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/files/{file_id}/move" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"new_parent_id":"FOLDER_ID"}'

# Trash a file
curl -s -X DELETE "https://api.atris.ai/api/integrations/google-drive/files/{file_id}?trash=true" \
  -H "Authorization: Bearer $TOKEN"

# Create a spreadsheet
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/sheets" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"New Sheet"}'

# Format cells (bold header row)
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/sheets/{id}/batchUpdate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"requests":[{"repeatCell":{"range":{"sheetId":0,"startRowIndex":0,"endRowIndex":1},"cell":{"userEnteredFormat":{"textFormat":{"bold":true}}},"fields":"userEnteredFormat.textFormat.bold"}}]}'

# Update an existing file
curl -s -X PUT "https://api.atris.ai/api/integrations/google-drive/files/{file_id}" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"Updated content","mime_type":"text/plain"}'

# Create a Google Doc
curl -s -X POST "https://api.atris.ai/api/integrations/google-docs/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"New Doc"}'

# Insert text into a Doc
curl -s -X POST "https://api.atris.ai/api/integrations/google-docs/documents/DOC_ID/batch-update" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"requests":[{"insertText":{"location":{"index":1},"text":"Hello world\n"}}]}'
```

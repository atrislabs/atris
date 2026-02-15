---
name: slides
description: Google Slides integration via AtrisOS API. List, create, read, and update presentations. Add slides, text, shapes, images. Export to PDF. Use when user asks about slides, presentations, decks, or pitch decks.
version: 1.0.0
tags:
  - slides
  - google
  - productivity
---

# Google Slides Agent

> Drop this in `~/.claude/skills/slides/SKILL.md` and Claude Code becomes your presentation assistant.

## Prerequisites

Google Slides shares OAuth with Google Drive. If Drive is connected, Slides works automatically. If not:

```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Check if Drive is connected (Slides piggybacks on Drive)
curl -s "https://api.atris.ai/api/integrations/google-drive/status" -H "Authorization: Bearer $TOKEN"

# If not connected, start Drive OAuth (includes Slides scope)
curl -s -X POST "https://api.atris.ai/api/integrations/google-drive/start" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"next_url":"https://atris.ai/dashboard/settings"}'
```

---

## API Reference

Base: `https://api.atris.ai/api/integrations/google-slides`

All requests require: `-H "Authorization: Bearer $TOKEN"`

### Get Token
```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
```

---

## Presentations

### List Presentations
```bash
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations?page_size=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Get a Presentation (with all slides)
```bash
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations/{presentation_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Create a Presentation
```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-slides/presentations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Q1 2026 Review"}'
```

---

## Updating Slides (batch-update)

All slide mutations use the batch-update endpoint. This is the most powerful endpoint — it can add slides, insert text, add shapes, images, change formatting, and more.

```bash
curl -s -X POST "https://api.atris.ai/api/integrations/google-slides/presentations/{id}/batch-update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requests": [...]}'
```

### Add a Blank Slide
```json
{
  "requests": [
    {
      "createSlide": {
        "insertionIndex": 1,
        "slideLayoutReference": {
          "predefinedLayout": "BLANK"
        }
      }
    }
  ]
}
```

**Available layouts:** `BLANK`, `TITLE`, `TITLE_AND_BODY`, `TITLE_AND_TWO_COLUMNS`, `TITLE_ONLY`, `SECTION_HEADER`, `SECTION_TITLE_AND_DESCRIPTION`, `ONE_COLUMN_TEXT`, `MAIN_POINT`, `BIG_NUMBER`

### Add a Title Slide
```json
{
  "requests": [
    {
      "createSlide": {
        "insertionIndex": 0,
        "slideLayoutReference": {
          "predefinedLayout": "TITLE"
        },
        "placeholderIdMappings": [
          {"layoutPlaceholder": {"type": "TITLE"}, "objectId": "titleId"},
          {"layoutPlaceholder": {"type": "SUBTITLE"}, "objectId": "subtitleId"}
        ]
      }
    },
    {
      "insertText": {
        "objectId": "titleId",
        "text": "Q1 2026 Review"
      }
    },
    {
      "insertText": {
        "objectId": "subtitleId",
        "text": "Atris Labs - Confidential"
      }
    }
  ]
}
```

### Insert Text into an Element
```json
{
  "requests": [
    {
      "insertText": {
        "objectId": "ELEMENT_ID",
        "text": "Hello, world!"
      }
    }
  ]
}
```

### Add a Text Box
```json
{
  "requests": [
    {
      "createShape": {
        "objectId": "myTextBox1",
        "shapeType": "TEXT_BOX",
        "elementProperties": {
          "pageObjectId": "SLIDE_ID",
          "size": {
            "width": {"magnitude": 400, "unit": "PT"},
            "height": {"magnitude": 50, "unit": "PT"}
          },
          "transform": {
            "scaleX": 1, "scaleY": 1,
            "translateX": 100, "translateY": 200,
            "unit": "PT"
          }
        }
      }
    },
    {
      "insertText": {
        "objectId": "myTextBox1",
        "text": "Custom text here"
      }
    }
  ]
}
```

### Add an Image
```json
{
  "requests": [
    {
      "createImage": {
        "objectId": "myImage1",
        "url": "https://example.com/image.png",
        "elementProperties": {
          "pageObjectId": "SLIDE_ID",
          "size": {
            "width": {"magnitude": 300, "unit": "PT"},
            "height": {"magnitude": 200, "unit": "PT"}
          },
          "transform": {
            "scaleX": 1, "scaleY": 1,
            "translateX": 150, "translateY": 100,
            "unit": "PT"
          }
        }
      }
    }
  ]
}
```

### Replace All Text (find & replace)
```json
{
  "requests": [
    {
      "replaceAllText": {
        "containsText": {"text": "{{company_name}}"},
        "replaceText": "Atris Labs"
      }
    }
  ]
}
```

### Delete a Slide or Element
```json
{
  "requests": [
    {
      "deleteObject": {
        "objectId": "SLIDE_OR_ELEMENT_ID"
      }
    }
  ]
}
```

### Style Text
```json
{
  "requests": [
    {
      "updateTextStyle": {
        "objectId": "ELEMENT_ID",
        "style": {
          "bold": true,
          "fontSize": {"magnitude": 24, "unit": "PT"},
          "foregroundColor": {
            "opaqueColor": {"rgbColor": {"red": 0.2, "green": 0.2, "blue": 0.8}}
          }
        },
        "fields": "bold,fontSize,foregroundColor"
      }
    }
  ]
}
```

---

## Pages (Individual Slides)

### Get a Single Slide
```bash
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations/{id}/pages/{page_id}" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Slide Thumbnail
```bash
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations/{id}/pages/{page_id}/thumbnail" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Export

### Export as PDF
```bash
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations/{id}/export" \
  -H "Authorization: Bearer $TOKEN"
```
Returns `{"pdf_base64": "...", "content_type": "application/pdf"}`.

---

## Workflows

### "Create a pitch deck"
1. Create presentation: `POST /presentations` with title
2. Get the presentation to find the first slide ID
3. Batch update: add title slide, content slides, closing slide
4. Each slide: createSlide + insertText for content
5. Return the presentation URL: `https://docs.google.com/presentation/d/{id}`

### "List my presentations"
1. `GET /presentations`
2. Display: name, last modified, link

### "Add a slide to an existing deck"
1. `GET /presentations/{id}` to see current slides
2. Batch update: createSlide at the desired index
3. Add content with insertText, createShape, createImage

### "Export deck to PDF"
1. `GET /presentations/{id}/export`
2. Decode base64 and save to file

### "Update text in a deck"
1. `GET /presentations/{id}` to find element IDs
2. Batch update with replaceAllText for template variables
3. Or insertText/deleteText for specific elements

---

## Important Notes

- **Shares Drive OAuth** — no separate connection needed. If Drive is connected, Slides works
- **Batch update is everything** — all slide mutations (add, edit, delete, style) go through batch-update
- **Object IDs** — every slide, shape, text box, image has an ID. Get them from `GET /presentations/{id}`
- **Slide size** — default is 10x5.63 inches (720x406.5 PT). Position elements accordingly
- **Images** — must be publicly accessible URLs. For private images, upload to Drive first
- **Templates** — use replaceAllText with `{{placeholder}}` patterns for template-based decks

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `Drive not connected` | No Drive OAuth token | Connect Google Drive first |
| `403 insufficient_scope` | Token missing presentations scope | Reconnect Drive to get updated scopes |
| `404 not_found` | Presentation doesn't exist | Check presentation ID |
| `400 invalid_request` | Bad batch update request | Check request format against API docs |

---

## Quick Reference

```bash
# Get token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# List presentations
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations" -H "Authorization: Bearer $TOKEN"

# Create presentation
curl -s -X POST "https://api.atris.ai/api/integrations/google-slides/presentations" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"My Deck"}'

# Get presentation (with all slides)
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations/PRES_ID" -H "Authorization: Bearer $TOKEN"

# Add a slide with text
curl -s -X POST "https://api.atris.ai/api/integrations/google-slides/presentations/PRES_ID/batch-update" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"requests":[{"createSlide":{"slideLayoutReference":{"predefinedLayout":"TITLE_AND_BODY"}}}]}'

# Export as PDF
curl -s "https://api.atris.ai/api/integrations/google-slides/presentations/PRES_ID/export" -H "Authorization: Bearer $TOKEN"
```

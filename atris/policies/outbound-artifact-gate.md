# Outbound Artifact Gate

Human-facing sends must ship the artifact in the format the recipient is meant to see.

This applies to email, Slack, docs, decks, HTML summaries, UI screenshots, customer updates, and team updates.

## Rule

Never send raw artifact source to a human unless the human explicitly asked for source.

Examples of raw source:
- HTML tags in a plain-text email body.
- Markdown code fences that are supposed to render into a page, doc, email, diagram, or UI.
- A screenshot, deck, PDF, or UI claim without visual proof.
- Generic copy that sounds like a template instead of this workspace and this recipient.

## Required Gate

Before sending, record:

1. Recipient and channel.
2. Intended format: plain text, rendered HTML, PDF, deck, screenshot, doc, or source.
3. Render proof for HTML or visual artifacts: preview, screenshot, PDF export, rendered email receipt, or browser check.
4. Anti-slop pass: concrete copy, no hype terms, no corporate filler, no AI-tell phrases.
5. Approval packet: exact recipient, subject or title, final body, and attachments.
6. Receipt after send: message id, link, file path, or explicit `not sent`.

## Hard Fails

Stop before send when any of these are true:

- Plain text contains `<html`, `<body`, `<div`, `<table`, or other HTML tags.
- A body contains fenced rendered source like `html`, `tsx`, `svg`, or `mermaid` that the recipient was meant to see rendered.
- HTML email has no render proof.
- Visual work has no visual inspection proof.
- Copy contains anti-slop kill-list terms such as `seamlessly`, `leverage`, `robust`, `game-changing`, or `at the end of the day`.
- The agent cannot show the exact final recipient, subject, body, and attachments before send.

## Validator

Run the cheap local gate before any human-facing send:

```bash
node scripts/outbound-artifact-gate.js --channel email --format plain --body-file /path/to/body.txt
node scripts/outbound-artifact-gate.js --channel email --format html --body-file /path/to/body.html --proof-file /path/to/render-proof.txt
```

The Gmail backend MIME fix is a transport safety net. Agents still need this gate before asking approval or sending.

Day-loop coach messages use the stricter surface rules in `atris/policies/day-loop-voice.md` and pass `--coach-surface`. Warm pings also name a fresh `--signal-proof` file.

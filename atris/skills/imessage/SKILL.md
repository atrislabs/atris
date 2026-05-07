---
name: imessage
description: Use when an agent needs to inspect or send local macOS iMessage through Atris CLI. Triggers on iMessage, Messages.app, local text messages, chat.db, or texting someone from the user's Mac.
version: 1.0.0
tags:
  - imessage
  - local
  - messaging
---

# iMessage

Local iMessage is a Mac capability, not a cloud OAuth integration.

Use Atris CLI as the control surface.

1. Check availability first.

```bash
atris imessage doctor --json
```

2. If the doctor says permissions are missing, ask the user to grant Full Disk Access to the terminal or Atris Desktop.

3. Read context only when needed.

```bash
atris imessage recent "+15555555555" --limit 20
```

4. Resolve named contacts through the cached local lookup command. Use `--refresh` only when the cache is stale or the result looks wrong.

```bash
atris imessage lookup --name "Exact Contact Name" --json
atris imessage lookup --name "myself" --json
```

If lookup returns `unique: true`, use `primary.handle` for the send. If lookup returns `ambiguous: true`, ask one concise clarification with the candidate names. If it returns no matches, ask for a phone number or exact contact name. Do not scan Contacts manually or loop over AppleScript; the CLI caches lookup results in `~/.atris/cache/imessage-contacts.json`.

5. Never send a message unless the user approved the exact recipient and exact text.

6. For sending, use the fast local send command only after explicit approval.

```bash
atris imessage send --to "+15555555555" --text "Exact approved text" --approved --json --receipt
```

The command normalizes US 10-digit phone numbers to `+1...`, checks `doctor`, sends through the local Messages AppleScript path using `service type = iMessage`, and returns JSON proof after the latest-outgoing Messages DB row settles. Use `--receipt` inside an Atris workspace when the action needs a durable `atris/runs/imessage-send-*.md` receipt.

If the recipient name is ambiguous, ask one concise clarification before sending. If the user gave a phone number or exact resolved handle, do not search the repo first.

## Status Meaning

- `connected: true` means this Mac can access the local Messages database and local scripting tools.
- `connected: false` means the user needs macOS permissions, Messages setup, or local tooling.

## Boundaries

- Do not route iMessage setup through Google OAuth.
- Do not treat iMessage as a cloud credential.
- Do not upload message contents unless the user explicitly asks.

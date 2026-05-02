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

4. Never send a message unless the user approved the exact recipient and exact text.

5. For sending, use the project-approved local iMessage path only after explicit approval.

## Status Meaning

- `connected: true` means this Mac can access the local Messages database and local scripting tools.
- `connected: false` means the user needs macOS permissions, Messages setup, or local tooling.

## Boundaries

- Do not route iMessage setup through Google OAuth.
- Do not treat iMessage as a cloud credential.
- Do not upload message contents unless the user explicitly asks.

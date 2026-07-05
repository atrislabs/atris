---
name: render-cli
description: Use the Render.com CLI v2.x (`render`) to inspect Render services, check CLI auth, list services and deploys, trigger deploys when explicitly requested, and view logs. Use when an agent needs Render CLI commands, non-interactive flags, deploy status polling, or service auto-deploy checks.
version: 1.0.0
tags:
  - render
  - deploy
  - cli
---

# Render CLI

Use the `render` binary to manage Render services, deploys, logs, and sessions from the terminal. Treat it like a production-control CLI: read first, parse JSON, and only create or mutate resources when the operator explicitly asked for that action.

## Agent defaults

Always add these flags for agent-safe commands:

- `--output json` for parseable output.
- `--confirm` to skip confirmation prompts.

The CLI defaults to interactive mode and can hang an agent if a command prompts. If a command is intended to run unattended, include both flags unless the CLI help says the mode is interactive-only.

## Auth

Check the active login before assuming access:

```bash
render whoami --output json --confirm
```

If the user is not logged in, ask them to complete:

```bash
render login
```

`render login` uses the dashboard/browser login flow, so do not run it in an unattended automation loop.

## Services

List services in the active workspace:

```bash
render services --output json --confirm
```

Use the returned service `id` as `<service-id>` in deploy and log commands. When a push to Git did not deploy, inspect the service JSON for `autoDeploy`; it may be disabled for that service.

## Deploys

Trigger a deploy only when the operator explicitly asks for a real deploy:

```bash
render deploys create <service-id> --output json --confirm
```

Watch deploy state by polling:

```bash
render deploys list <service-id> --output json --confirm
```

Common deploy statuses include `queued`, `build_in_progress`, `update_in_progress`, `live`, and `failed`. Treat `live` and `failed` as terminal states for ordinary deploy monitoring.

## Logs

Query recent logs for a service:

```bash
render logs --resources <service-id> --limit 100 --output json --confirm
```

For a live tail, use:

```bash
render logs --resources <service-id> --tail --confirm
```

The CLI help says `--tail` streams only in interactive mode, so prefer bounded JSON log queries for automated agents and use live tail only when a long-running interactive stream is acceptable.

## Gotchas

- The CLI is interactive by default; `--confirm` prevents confirmation prompts from blocking the agent.
- `--output json` makes service, deploy, and log output machine-readable.
- In non-interactive log mode, `--resources <service-id>` is required.
- Git pushes do not guarantee deploys. Check `autoDeploy` in the service JSON before assuming push-to-git should deploy.
- Do not use placeholder IDs in real commands. Resolve a service ID from `render services --output json --confirm` first.

# {{name}} — Live Workspace

## Business

- ID: `{{business_id}}`
- Slug: `{{slug}}`

## Workspace

- ID: `{{workspace_id}}`

## Separation Rule

This workspace should know {{name}}, not any other business.
Do not mix context across workspaces.

## Current Loop

- primary workflow: define the first measurable loop here
- primary operator: add the human approval surface here
- next artifact: add the first report, note, or recap artifact here

## Structured State

- `.atris/state/_sync.json` - workspace sync receipt
- `.atris/state/events.jsonl` - raw events
- `.atris/state/episodes.jsonl` - episodes
- `.atris/state/scorecards.jsonl` - scorecards

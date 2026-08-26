# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

(Empty)

## In Progress

(Empty)

## Review

- **[EMF-1]** Atris engine asks select the real Fable model, allow deep Fable answers enough time, and record the resolved model. [engines]
  **Why it matters:** Operators choose Fable for its reasoning; silently running another model or killing it early makes the engine door dishonest.
  **Done looks like:** A default Fable ask launches claude-fable-5, uses the longer Fable timeout unless explicitly overridden, records that model, and passes focused tests plus a live ask.
  **Approve or change:** `atris task show EMF-1` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Fix Fable engine routing and deep ask timeouts
  **Verify:** node --test test/engine-ask.test.js test/runner-command.test.js

## Blocked

(Empty)

## Completed

(Empty)

# TODO.md

> **Last updated:** 2026-04-13

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.
The `## Endgame` section below holds the current horizon; `[endgame]`-tagged
tasks in `## Backlog` are pursued by /autopilot in priority order until done,
then /endgame picks the next horizon at the boundary.

---

## Endgame

**Slug:** agent-commands-solid
**Picked:** 2026-04-14 23:00
**Done when:** `atris agent` + `atris chat` handle expired tokens, plan/do/review accept `--agent <name>` to pick which agent runs the work, and one end-to-end test proves agent selection + chat + plan cycle works without manual token refresh.
**Source:** boundary — "check-before-acting" complete (I4 shipped, backlog empty). Agent commands exist (agent, chat, plan --execute) but token refresh is unguarded and agent selection doesn't carry through plan/do/review. Queued: agent-coordinator.

---

## Backlog

- **T1:** Guard token expiry in agent-using commands — loadCredentials() must call ensureValidCredentials() before API calls [endgame] [execute]
  **Exit:** expired token triggers refresh, not silent failure
  **Verify:** `grep -c "ensureValidCredentials" commands/workflow.js | grep -v "^0$"`
  **After:** none
- **T2:** Add `--agent <name>` flag to plan/do/review commands — agent selection carries through the workflow [endgame] [execute]
  **Exit:** `atris plan --agent researcher` uses the researcher agent, not default
  **Verify:** `grep -c "\-\-agent" commands/workflow.js | grep -v "^0$"`
  **After:** T1
- **T3:** End-to-end smoke test — select agent, chat, plan cycle completes without manual intervention [endgame] [execute]
  **Exit:** scripted test runs agent select + chat + plan and exits 0
  **Verify:** `node tests/agent-e2e.js` exits 0
  **After:** T2

## In Progress

- **T8:** Navigator fixture task — append a navigator stamp line to atris/logs/2026/2026-04-19.md under ## Notes [execute]
  **Claimed by:** Executor at 2026-04-19T22:42:17.319Z
  **Stage:** DO
  **Exit:** one `### Navigator Fixture — YYYY-MM-DD HH:MM` line appears in today's log Notes section
  **Verify:** `grep -c "### Navigator Fixture — 2026-04-19" atris/logs/2026/2026-04-19.md | grep -v "^0$"`
  **After:** none

---

## Completed

- **T4:** Audit CLI bloat against atrisos-backend boundary [explore]
  **Exit:** identify concrete trim targets or duplication hotspots with file references and keep/cut recommendation
  **Result:** command sprawl and backend-coupled modules are the main bloat; npm package size is modest

- **T5:** Verify business computer flow against atris-labs-1 [execute]
  **Exit:** run live CLI checks against atris-labs-1 and confirm business binding + computer path works or capture the failing step
  **Result:** business chat bridge returned 502, but `commands/computer.js` now falls back to a direct runner proxy and live exec/chat both work in atris-labs-1

---

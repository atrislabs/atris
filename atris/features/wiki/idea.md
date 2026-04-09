# Local-First Wiki

> **Status:** shipped
> **Created:** 2026-04-07
> **Last Updated:** 2026-04-07

---

## Problem Statement

The wiki command existed as a cloud-first path with its prompt and schema trapped inside `commands/wiki.js`. That made local project memory awkward, kept the wiki root inconsistent with the rest of the Atris workspace, and forced people to think about business routing before they could just wiki something.

---

## Solution Design

Make local the default and brand the memory layer as `atris/wiki/`. Shared prompt, schema, scaffold, and path logic move into `lib/wiki.js`; `commands/wiki.js` becomes a router that prints local prompts by default and uses the same prompt builders for `--cloud`. Safe top-level aliases (`atris ingest`, `atris query`, `atris lint`) shorten the common path, while `pull --only wiki` and `push --only wiki` normalize to the canonical root.

Cron-driven self-improvement and a deeper vibe-check loop stay as the next layer, not fake-finished in this slice.

---

## ASCII Visualization

```text
raw source / question
        |
        v
  atris ingest|query|lint
        |
        +--> local default
        |     |
        |     v
        |  atris/wiki/
        |   |- wiki.md
        |   |- index.md
        |   |- log.md
        |   |- STATUS.md
        |   |- people/
        |   |- systems/
        |   |- concepts/
        |   `- briefs/
        |
        `--> --cloud
              |
              v
        business workspace
        same prompt shape
```

---

## Success Criteria

- [x] `atris ingest` creates the canonical `atris/wiki/` scaffold locally
- [x] `atris wiki ingest|query|lint` default to local mode and accept `--cloud`
- [x] Prompt and schema logic are shared between local and cloud paths
- [x] `atris query` and `atris lint` work as safe top-level aliases
- [x] `pull --only wiki` and `push --only wiki` normalize to `atris/wiki/`
- [x] A project-local wiki skill exists so future agents follow the same rules
- [x] Focused tests cover the shipped local-first flow
- [x] `atris init` scaffolds the wiki in every new workspace
- [x] `atris activate` surfaces wiki state at session start
- [x] Atris agent/spec docs teach the loop to read and validate the wiki
- [x] This repo has a seeded `atris/wiki/` instead of shipping the feature empty

---

## User Impact

You can now build project memory without leaving the repo or paying the cloud path by default. `atris/wiki/` becomes the obvious place where the repo’s brain lives, while `--cloud` stays available when you actually want the remote workspace involved.

---

## Technical Notes

- `log` and `search` already mean journal operations, so they stay namespaced under `atris wiki`.
- Local mode prints the prompt for the current coding agent and scaffolds the wiki files; it does not pretend to be an embedded LLM runtime.
- Legacy `wiki/` roots are still discoverable for read paths to avoid breaking older workspaces immediately.
- The follow-up integration slice makes the wiki compound on session start instead of staying write-only.

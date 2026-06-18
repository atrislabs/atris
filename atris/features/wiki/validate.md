---
last_compiled: 2026-06-18
sources:
  - lib/wiki.js:15-25 (public/private wiki root getters)
  - lib/wiki.js:192-217 (wiki and context scaffold)
  - lib/wiki.js:246-326 (staged ingest packs and manifests)
  - lib/wiki.js:436-619 (stale, orphan, and agent-readable checks)
  - lib/wiki.js:620-805 (status/log writes and prompt builders)
  - commands/wiki.js:501-510 (local/private ingest and query)
  - commands/wiki.js:511-560 (lint, search, log, verify)
  - commands/wiki.js:484-583 (wiki dispatch and help)
  - commands/loop.js:1-114 (local wiki upkeep loop)
  - commands/init.js:371-374 (wiki scaffold during init)
  - commands/activate.js:141-158 (session-start wiki status)
  - commands/pull.js:225 (wiki prefix normalization)
  - commands/push.js:307 (wiki prefix normalization)
  - bin/atris.js:349-354 (top-level wiki help — ingest/query/lint/loop lines)
  - bin/atris.js:1824-1844 (wiki, ingest, query, lint, loop routes)
  - test/commands.test.js:13666 (wiki scaffold coverage)
  - test/commands.test.js:15982-16043 (wiki loop stale/suggest coverage)
  - atris/skills/wiki/SKILL.md
---

# Wiki — Validation

> **Status:** v2 — local-first wiki plus upkeep loop
> **Validated:** 2026-06-18
> **Exit condition:** local/public and private wiki flows work, canonical root is `atris/wiki/`, init scaffolds it, activate surfaces it, agent/spec docs reference it, stale/orphan upkeep is executable, and this repo dogfoods it.

## Checks

- [x] `atris ingest` scaffolds `atris/wiki/` locally
- [x] `atris ingest` stages source packs under `atris/context/_ingest/` with manifest receipts
- [x] `atris wiki ingest --private` scaffolds `.atris/presidio/`
- [x] `atris query` defaults to local wiki mode
- [x] `atris lint` defaults to local wiki mode
- [x] `atris wiki search` reads `atris/wiki/index.md`
- [x] `atris wiki log` reads `atris/wiki/log.md`
- [x] `atris wiki verify` checks sources, `last_compiled`, `last_verified`, confidence, dependencies, actionability, and stale sources
- [x] `atris loop` flags stale wiki pages, orphan pages, and next ingest candidates while refreshing `STATUS.md` and `log.md`
- [x] `atris wiki loop` aliases the same upkeep analysis
- [x] `pull --only wiki` and `push --only wiki` normalize to `atris/wiki/`
- [x] `atris init` creates the wiki scaffold
- [x] `atris activate` reads `atris/wiki/STATUS.md`
- [x] A project-local wiki skill exists
- [x] Agent/spec docs mention the wiki loop
- [x] `atris-cli` itself has a seeded `atris/wiki/`

## Current Verification

```bash
node --test test/commands.test.js --test-name-pattern 'wiki|loop'
node -c lib/wiki.js
node -c commands/wiki.js
node -c commands/loop.js
node bin/atris.js wiki --help
node bin/atris.js loop --dry-run
```

`npm test` remains the full regression gate; the focused command above covers the wiki behavior directly.

## Known Content Debt

- `node bin/atris.js wiki verify` currently fails this repo's wiki content: 15 pages, 84 findings.
- The top causes are missing `last_compiled`, `last_verified`, confidence, dependencies, actionability, stale sources, and 2 orphan pages.
- `node bin/atris.js loop --dry-run` is the current remediation queue: 13 stale pages, starting with `atris/wiki/people/jack-dorsey.md`.

## Notes

- `log` and `search` stay under `atris wiki` because the top-level CLI already uses those names for journals.
- Cloud ingest/query/lint remains opt-in with `--cloud`; cloud wiki verify is intentionally local-first after pull.
- Cron-driven upkeep and vibe-check interviewing are intentionally not part of this slice.

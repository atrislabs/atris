---
last_compiled: 2026-07-25
sources:
  - lib/wiki.js:15-25 (public/private wiki root getters)
  - lib/wiki.js:192-218 (wiki and context scaffold)
  - lib/wiki.js:246-326 (staged ingest packs and manifests)
  - lib/wiki.js:436-619 (stale, orphan, and agent-readable checks)
  - lib/wiki.js:620-825 (status/log writes and prompt builders)
  - commands/wiki.js:501-510 (local/private ingest and query)
  - commands/wiki.js:511-570 (lint, search, log, verify)
  - commands/wiki.js:484-571 (wiki dispatch and help)
  - commands/loop.js:1-114 (local wiki upkeep loop)
  - commands/init.js:410 (ensureWikiScaffold during init; imported at commands/init.js:4)
  - commands/activate.js:172 (session-start readWikiStatus)
  - commands/activate.js:262 (void wikiStatus, read but no longer rendered)
  - commands/pull.js:238 (wiki prefix normalization)
  - commands/push.js:68 (wiki prefix normalization)
  - bin/atris.js:540-543 (top-level wiki help, the ingest/query/lint/loop lines)
  - bin/atris.js:2732-2751 (wiki, ingest, query, lint, loop routes)
  - test/commands.test.js:19492 (wiki scaffold coverage)
  - test/commands.test.js:19715-19784 (wiki loop stale/suggest/alias coverage)
  - atris/skills/wiki/SKILL.md
---

# Wiki — Validation

> **Status:** v3, local-first wiki with executable upkeep; the repo baseline is no longer clean
> **Validated:** 2026-07-25
> **Exit condition:** local/public and private wiki flows work, canonical root is `atris/wiki/`, init scaffolds it, activate reads it, agent/spec docs reference it, stale/orphan upkeep is executable, and this repo dogfoods it.

## Checks

- [x] `atris ingest` scaffolds `atris/wiki/` locally
- [x] `atris ingest` stages source packs under `atris/context/_ingest/` with manifest receipts
- [x] `atris wiki ingest --private` scaffolds `.atris/presidio/`
- [x] `atris query` defaults to local wiki mode
- [x] `atris lint` defaults to local wiki mode
- [x] `atris wiki search` reads `atris/wiki/index.md`
- [x] `atris wiki log` reads `atris/wiki/log.md`
- [x] `atris wiki verify` checks sources, `last_compiled`, `last_verified`, confidence, dependencies, actionability, and stale sources
- [x] `atris loop wiki` flags stale wiki pages, orphan pages, and next ingest candidates while refreshing `STATUS.md` and `log.md`
- [x] `atris wiki loop` aliases the same upkeep analysis
- [ ] Bare `atris loop` runs wiki upkeep. It no longer does: `bin/atris.js:2743` routes `loop` to `commands/loop-front.js`, the self-improvement front door, which forwards only the `wiki` subcommand to `commands/loop.js`. The top-level help line at `bin/atris.js:543` still describes `loop` as the wiki upkeep loop and is now wrong.
- [x] `pull --only wiki` and `push --only wiki` normalize to `atris/wiki/`
- [x] `atris init` creates the wiki scaffold
- [~] `atris activate` reads `atris/wiki/STATUS.md` (`commands/activate.js:172`) but no longer shows it. The boot narration rewrite dropped the wiki line and the value is now discarded at `commands/activate.js:262` (`void wikiStatus`), so wiki health is not surfaced at session start.
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
node bin/atris.js wiki verify
node bin/atris.js loop wiki --json
node bin/atris.js clean --dry-run --json
```

`npm test` remains the full regression gate; the focused command above covers the wiki behavior directly.

## Current Repo Proof

Measured 2026-07-25. The wiki has grown from 22 to 26 pages and the clean baseline recorded on 2026-07-12 has since regressed.

- `node bin/atris.js wiki verify` now reports `fail` on this repo's public wiki: 26 pages, 24 findings. The findings are missing frontmatter contract keys (`sources`, `last_compiled`, `last_verified`, `confidence`, `dependencies`, actionability) concentrated in `atris/wiki/systems/loops.md`, `atris/wiki/concepts/loops-missions-members.md`, and `atris/wiki/concepts/wisdom-traditions-operating-doctrine.md`.
- `node bin/atris.js loop wiki --json` reports 26 pages, 1 stale page (`atris/wiki/concepts/wisdom-traditions-operating-doctrine.md`, missing `last_compiled`), 1 orphan page (`atris/wiki/systems/loops.md`), 0 next-ingest candidates, and `health: "1 stale page need recompiling"`.
- The upkeep machinery is what is being validated here, and it works: it correctly detects the three uncompiled pages. Fixing those pages is wiki content work, not a defect in this feature.

## Notes

- `log` and `search` stay under `atris wiki` because the top-level CLI already uses those names for journals.
- Cloud ingest/query/lint remains opt-in with `--cloud`; cloud wiki verify is intentionally local-first after pull.
- Cron-driven upkeep and vibe-check interviewing are intentionally not part of this slice.

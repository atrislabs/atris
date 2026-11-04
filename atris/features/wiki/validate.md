---
last_compiled: 2026-10-23
sources:
  - lib/wiki.js:22-32 (public/private wiki root getters)
  - lib/wiki.js:199-224 (wiki and context scaffold)
  - lib/wiki.js:253-332 (staged ingest packs and manifests)
  - lib/wiki.js:443-572 (page reads, stale and orphan checks)
  - lib/wiki.js:702-743 (agent-readable contract checks)
  - lib/wiki.js:745-946 (suggested sources, status/log writes, and prompt builders)
  - commands/wiki.js:299-366 (local/private ingest and query)
  - commands/wiki.js:368-515 (lint, consolidate, search, log, verify)
  - commands/wiki.js:178-227 (wiki help)
  - commands/wiki.js:517-609 (wiki dispatch)
  - commands/loop.js:1-114 (local wiki upkeep loop)
  - commands/loop-front.js:34-70 (top-level loop router, wiki forwarded to loop.js)
  - commands/init.js:478 (ensureWorkspaceBrain during init; imported at commands/init.js:5)
  - lib/workspace-scaffold.js:125-134 (ensureWorkspaceBrain calls ensureWikiScaffold)
  - commands/activate.js:112-117 (wikiHealthSentence)
  - commands/activate.js:178 (session-start readWikiStatus)
  - commands/activate.js:278 (wiki health line in the boot status)
  - commands/pull.js:238 (wiki prefix normalization)
  - commands/push.js:68 (wiki prefix normalization)
  - bin/atris.js:654-657 (top-level wiki help, the ingest/query/lint/loop lines)
  - bin/atris.js:3240-3259 (wiki, ingest, query, lint, loop routes)
  - test/commands-7.test.js:1860 (init wiki scaffold coverage)
  - test/commands-8.test.js:1785-2102 (wiki help, ingest, query, search, log, contract, stale, orphan, and loop coverage)
  - test/activate-wiki-line.test.js
  - atris/skills/wiki/SKILL.md
  - .gitignore:41 (atris/wiki is local-only)
---

# Wiki: Validation

> **Status:** v3, local-first wiki with executable upkeep; the wiki itself is local-only workspace memory and is not tracked in this repo
> **Validated:** 2026-10-23
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
- [ ] Bare `atris loop` runs wiki upkeep. It does not, by design: `bin/atris.js:3251` routes `loop` to `commands/loop-front.js`, the self-improvement front door, which forwards only the `wiki` subcommand to `commands/loop.js`. The top-level help line at `bin/atris.js:657` now says so ("wiki upkeep lives under: loop wiki"), but `README.md` lines 96, 343, and 368 still describe bare `atris loop` as wiki upkeep.
- [x] `pull --only wiki` and `push --only wiki` normalize to `atris/wiki/`
- [x] `atris init` creates the wiki scaffold, through `ensureWorkspaceBrain` in `lib/workspace-scaffold.js`
- [x] `atris activate` reads `atris/wiki/STATUS.md` (`commands/activate.js:178`) and, when a status bullet mentions stale or orphan pages, adds one plain line to the boot status telling the reader to run `atris loop wiki` (`commands/activate.js:112-117`, shown at line 278). A healthy or missing wiki adds nothing, and the line never quotes paths.
- [x] A project-local wiki skill exists
- [x] Agent/spec docs mention the wiki loop
- [ ] `atris-cli` itself has a seeded `atris/wiki/`. It no longer ships one: `.gitignore:41` ignores `atris/wiki/`, and a fresh checkout has no wiki until a command scaffolds one.

## Current Verification

```bash
node --test --test-name-pattern 'wiki|loop' test/commands-7.test.js test/commands-8.test.js test/activate-wiki-line.test.js
node -c lib/wiki.js
node -c commands/wiki.js
node -c commands/loop.js
node bin/atris.js wiki --help
node bin/atris.js wiki verify
node bin/atris.js loop wiki --dry-run --json
node bin/atris.js clean --dry-run --json
```

`npm test` remains the full regression gate; the focused command above covers the wiki behavior directly.

## Current Repo Proof

_Point-in-time snapshot from 2026-10-23. The wiki is local workspace memory, so these numbers depend on the machine and change with every ingest._

- In a fresh checkout, `node bin/atris.js wiki verify` prints `No local wiki found at atris/wiki.` and exits 1, because the wiki is not tracked.
- `node bin/atris.js loop wiki --dry-run --json` then scaffolds the empty wiki and reports 0 pages, 0 stale, 0 orphans, and 3 next-ingest candidates (`README.md`, `atris/CLAUDE.md`, `atris/atris.md`), with health `wiki is stable, 3 high-value sources ready for ingest`.
- The upkeep machinery is what is being validated here; the focused tests above exercise stale, orphan, and suggestion detection on temporary workspaces.

## Notes

- `log` and `search` stay under `atris wiki` because the top-level CLI already uses those names for journals.
- Cloud ingest/query/lint remains opt-in with `--cloud`; cloud wiki verify is intentionally local-first after pull.
- `atris wiki` also has `consolidate`, `entities`, and `related` subcommands that this validation does not cover.
- Cron-driven upkeep and vibe-check interviewing are intentionally not part of this slice.

---
last_compiled: 2026-10-14
sources:
  - lib/wiki.js:22-32 (public/private wiki root getters)
  - lib/wiki.js:199-225 (wiki and context scaffold)
  - lib/wiki.js:253-332 (staged ingest packs and manifests)
  - lib/wiki.js:443-743 (stale, orphan, metabolism, and agent-readable checks)
  - lib/wiki.js:781-946 (status/log writes and prompt builders)
  - commands/wiki.js:299-367 (local/private ingest and query)
  - commands/wiki.js:368-516 (lint, consolidate, search, log, verify)
  - commands/wiki.js:517-609 (wiki dispatch)
  - commands/wiki.js:178-227 (wiki help)
  - commands/loop.js:1-114 (local wiki upkeep loop)
  - lib/workspace-scaffold.js:134 (ensureWikiScaffold during init; init imports ensureWorkspaceBrain at commands/init.js:5)
  - commands/activate.js:178 (session-start readWikiStatus)
  - commands/activate.js:112-117 (wikiHealthSentence, rendered at commands/activate.js:278)
  - commands/pull.js:238 (wiki prefix normalization)
  - commands/push.js:68 (wiki prefix normalization)
  - bin/atris.js:645-648 (top-level wiki help, the ingest/query/lint/loop lines)
  - bin/atris.js:3209-3229 (wiki, ingest, query, lint, loop routes)
  - test/commands.test.js:17691 (init wiki scaffold coverage)
  - test/commands.test.js:20314-20395 (wiki loop stale/suggest/alias/cloud coverage)
  - atris/skills/wiki/SKILL.md
---

# Wiki Validation

> **Status:** v3, local-first wiki with executable upkeep; the repo baseline is no longer clean
> **Validated:** 2026-07-25, rechecked 2026-10-14
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
- [x] Help points to the right upkeep entry. Bare `atris loop` is the loops front door by design (`bin/atris.js:3220` routes it to `commands/loop-front.js`, which forwards only `wiki` to `commands/loop.js`), and the top-level help line at `bin/atris.js:648` now says wiki upkeep lives under `loop wiki` (rechecked 2026-10-14).
- [x] `pull --only wiki` and `push --only wiki` normalize to `atris/wiki/`
- [x] `atris init` creates the wiki scaffold, now through the shared workspace scaffold (`lib/workspace-scaffold.js:134`)
- [x] `atris activate` reads `atris/wiki/STATUS.md` (`commands/activate.js:178`) and, when it lists stale or orphan pages, prints one line telling the reader to run `atris loop wiki` (`commands/activate.js:112-117`). It never quotes the status bullets themselves (rechecked 2026-10-14).
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

## Rechecked 2026-10-14

Run from a worktree, where `atris/wiki/` is ignored by git and starts empty, so page counts here do not compare with the July numbers from the main checkout.

- Every source ref above was read against current code and moved to its current lines. Init's wiki scaffold moved into the shared workspace scaffold in August, and help and dispatch in the wiki command now have separate refs.
- `node --test test/commands.test.js --test-name-pattern 'wiki|loop'` exits 0, 34 passed.
- `node -c` on the three wiki files exits 0; `wiki --help`, `wiki verify`, and `loop wiki --json` all exit 0.
- In a scratch workspace with one planted stale page, `loop wiki` writes `Health: 1 stale page need recompiling` to `STATUS.md`, and `activate` then prints `the wiki has pages going stale; refresh them: atris loop wiki`. That closes the half-done activate item.

## Notes

- `log` and `search` stay under `atris wiki` because the top-level CLI already uses those names for journals.
- Cloud ingest/query/lint remains opt-in with `--cloud`; cloud wiki verify is intentionally local-first after pull.
- Cron-driven upkeep and vibe-check interviewing are intentionally not part of this slice.

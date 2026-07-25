---
last_compiled: 2026-07-25
sources:
  - commands/loop.js:1-114 (report builder, dry-run/json/limit, STATUS/log writes)
  - commands/wiki.js:549-557 (wiki loop alias)
  - lib/wiki.js:436-619 (page reads, stale checks, orphan checks)
  - lib/wiki.js:620-705 (suggested sources, STATUS, log)
  - bin/atris.js:922-940 (showLoopHelp)
  - bin/atris.js:2743-2751 (top-level loop route, now via commands/loop-front.js)
  - test/commands.test.js:18016 (loop help coverage)
  - test/commands.test.js:19715-19784 (loop stale/suggest/alias coverage)
---

# Wiki Upkeep Loop — Validation

> **Status:** shipped local upkeep command; the entry point moved to `atris loop wiki`
> **Validated:** 2026-07-25
> **Exit condition:** `atris loop wiki` reports local wiki health deterministically, writes STATUS/log unless `--dry-run`, `atris wiki loop` aliases it, and test coverage proves stale/orphan/suggestion behavior.

## Checks

- [x] `atris loop wiki` runs against `atris/wiki/`
- [x] `atris wiki loop` routes to the same upkeep logic
- [ ] Bare `atris loop` runs wiki upkeep. It no longer does. `bin/atris.js:2743` now routes `loop` to `commands/loop-front.js`, the single front door to the self-improvement loop, which delegates to `run.js` and `pulse.js` and forwards only the `wiki` subcommand to `commands/loop.js`. Bare `atris loop` prints the self-improvement loop home screen. The `loop` help line at `bin/atris.js:543` still describes the old wiki behavior and is now wrong.
- [x] `--dry-run` reports without rewriting `STATUS.md` or `log.md`
- [x] `--json` emits the same report object for tools
- [x] `--limit=N` bounds next-ingest suggestions
- [x] `STATUS.md` refreshes `Last loop`, `Health`, and `Next move`
- [x] `log.md` gets a `LOOP` entry
- [x] stale page detection works
- [x] orphan page detection works
- [x] next-ingest suggestions work
- [x] targeted tests pass
- [ ] current repo reports a clean public wiki. It does not, as of 2026-07-25: 1 stale page and 1 orphan page. The detector working is the point of this feature; the content debt is tracked on the wiki side.

## Current Verification

```bash
node --test test/commands.test.js --test-name-pattern 'wiki|loop'
node -c commands/loop.js
node -c commands/wiki.js
node -c lib/wiki.js
node bin/atris.js loop --help
node bin/atris.js loop wiki --dry-run
node bin/atris.js loop wiki --dry-run --json
node bin/atris.js wiki loop --dry-run
node bin/atris.js loop wiki --json
```

## Current Repo Report

_Point-in-time snapshot from `node bin/atris.js loop wiki --json` on 2026-07-25 - recompiling or ingesting wiki pages changes these counts, so a mismatch here is drift, not a bug._

- Reports 26 pages, 1 stale page, 1 orphan page, and 0 next-ingest candidates.
- Stale: `atris/wiki/concepts/wisdom-traditions-operating-doctrine.md`, reason `missing last_compiled`. Orphan: `atris/wiki/systems/loops.md`.
- Health is `1 stale page need recompiling`.
- Next move is to recompile `atris/wiki/concepts/wisdom-traditions-operating-doctrine.md` from its source.

## Notes

- The upkeep command is local-first and does not auto-push.
- Cloud loop is intentionally not implemented; `atris wiki loop --cloud` exits with guidance to run local upkeep first.
- Scheduling belongs to the next layer; this feature just makes upkeep callable and testable.

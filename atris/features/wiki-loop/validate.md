---
last_compiled: 2026-10-23
sources:
  - commands/loop.js:1-114 (report builder, dry-run/json/limit, STATUS/log writes)
  - commands/wiki.js:586-595 (wiki loop alias)
  - lib/wiki.js:443-572 (page reads, stale checks, orphan checks)
  - lib/wiki.js:745-829 (suggested sources, STATUS, log)
  - commands/loop-front.js:34-70 (top-level loop router, wiki forwarded to loop.js)
  - bin/atris.js:1113-1131 (showLoopHelp)
  - bin/atris.js:3251-3259 (top-level loop route, now via commands/loop-front.js)
  - test/commands-8.test.js:324 (loop help coverage)
  - test/commands-8.test.js:2033-2102 (loop stale/suggest/alias coverage)
---

# Wiki Upkeep Loop: Validation

> **Status:** shipped local upkeep command; the entry point is `atris loop wiki`
> **Validated:** 2026-10-23
> **Exit condition:** `atris loop wiki` reports local wiki health deterministically, writes STATUS/log unless `--dry-run`, `atris wiki loop` aliases it, and test coverage proves stale/orphan/suggestion behavior.

## Checks

- [x] `atris loop wiki` runs against `atris/wiki/`
- [x] `atris wiki loop` routes to the same upkeep logic. It prints an `ACTION TAKEN` line before the report, so `atris wiki loop --json` is not pure JSON; use `atris loop wiki --json` for tools.
- [ ] Bare `atris loop` runs wiki upkeep. It does not, by design. `bin/atris.js:3251` routes `loop` to `commands/loop-front.js`, the single front door to the self-improvement loop, which delegates to `run.js` and `pulse.js` and forwards only the `wiki` subcommand to `commands/loop.js`. Bare `atris loop` prints the self-improvement loop home screen. `atris loop --help` (`showLoopHelp`) and the top-level help line both point at `atris loop wiki` for wiki upkeep.
- [x] `--dry-run` reports without rewriting `STATUS.md` or `log.md`. It still creates the empty wiki scaffold if `atris/wiki/` is missing, because the report builder calls `ensureWikiScaffold` first.
- [x] `--json` emits the same report object for tools
- [x] `--limit=N` bounds next-ingest suggestions
- [x] `STATUS.md` refreshes `Last loop`, `Health`, and `Next move`
- [x] `log.md` gets a `LOOP` entry
- [x] stale page detection works
- [x] orphan page detection works
- [x] next-ingest suggestions work
- [x] targeted tests pass
- [ ] current repo reports a clean public wiki. Not applicable any more: `atris/wiki/` is gitignored local workspace memory, so a fresh checkout has no pages to report on. The detector working is the point of this feature.

## Current Verification

```bash
node --test --test-name-pattern 'wiki|loop' test/commands-8.test.js
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

_Point-in-time snapshot from `node bin/atris.js loop wiki --dry-run --json` in a fresh checkout on 2026-10-23. The wiki is local and changes with every ingest, so a mismatch here is drift, not a bug._

- Reports 0 pages, 0 stale pages, 0 orphan pages, and 3 next-ingest candidates: `README.md`, `atris/CLAUDE.md`, `atris/atris.md`.
- Health is `wiki is stable, 3 high-value sources ready for ingest`.
- Next move is `ingest README.md`.

## Notes

- The upkeep command is local-first and does not auto-push.
- Cloud loop is intentionally not implemented; `atris wiki loop --cloud` exits 1 with guidance to run local upkeep first. That message still says "Run local `atris loop` first", which predates the move to `atris loop wiki`.
- Scheduling belongs to the next layer; this feature just makes upkeep callable and testable.

---
last_compiled: 2026-05-10
sources:
  - commands/loop.js:1-112 (report builder, dry-run/json/limit, STATUS/log writes)
  - commands/wiki.js:420-428 (wiki loop alias)
  - lib/wiki.js:436-619 (page reads, stale checks, orphan checks)
  - lib/wiki.js:620-704 (suggested sources, STATUS, log)
  - bin/atris.js:318-321 (loop help)
  - bin/atris.js:1321-1323 (top-level loop route)
  - test/commands.test.js:4225-4288 (loop command coverage)
---

# Wiki Upkeep Loop — Validation

> **Status:** shipped local upkeep command
> **Validated:** 2026-05-10
> **Exit condition:** `atris loop` reports local wiki health deterministically, writes STATUS/log unless `--dry-run`, `atris wiki loop` aliases it, and test coverage proves stale/orphan/suggestion behavior.

## Checks

- [x] `atris loop` runs against `atris/wiki/`
- [x] `atris wiki loop` routes to the same upkeep logic
- [x] `--dry-run` reports without rewriting `STATUS.md` or `log.md`
- [x] `--json` emits the same report object for tools
- [x] `--limit=N` bounds next-ingest suggestions
- [x] `STATUS.md` refreshes `Last loop`, `Health`, and `Next move`
- [x] `log.md` gets a `LOOP` entry
- [x] stale page detection works
- [x] orphan page detection works
- [x] next-ingest suggestions work
- [x] targeted tests pass
- [x] current repo dry-run reports real debt without mutating the wiki

## Current Verification

```bash
node --test test/commands.test.js --test-name-pattern 'wiki|loop'
node -c commands/loop.js
node -c commands/wiki.js
node -c lib/wiki.js
node bin/atris.js loop --dry-run
node bin/atris.js loop --dry-run --json
node bin/atris.js wiki loop --dry-run
```

## Current Repo Report

- `node bin/atris.js loop --dry-run` reports 15 pages, 13 stale pages, 2 orphans, and 3 next-ingest candidates.
- First remediation is `atris/wiki/people/jack-dorsey.md` from `https://www.youtube.com/watch?v=YTVSwOY19Qs`.
- Orphans currently reported: `atris/wiki/briefs/atrisos-generative-ui-product-surface.md` and `atris/wiki/briefs/launch-post.md`.

## Notes

- The upkeep command is local-first and does not auto-push.
- Cloud loop is intentionally not implemented; `atris wiki loop --cloud` exits with guidance to run local upkeep first.
- Scheduling belongs to the next layer; this feature just makes upkeep callable and testable.

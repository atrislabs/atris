---
last_compiled: 2026-04-07
sources:
  - commands/loop.js
  - commands/wiki.js
  - lib/wiki.js
  - bin/atris.js
  - test/commands.test.js
  - test/cli-smoke.test.js
  - atris/skills/loop/SKILL.md
---

# Wiki Upkeep Loop — Validation

> **Status:** shipped 2026-04-07
> **Exit condition:** `atris loop` updates local wiki state deterministically, `atris wiki loop` aliases it, and test coverage plus manual smoke prove the flow.

## Checks

- [x] `atris loop` runs against `atris/wiki/`
- [x] `atris wiki loop` routes to the same upkeep logic
- [x] `STATUS.md` refreshes `Last loop`, `Health`, and `Next move`
- [x] `log.md` gets a `LOOP` entry
- [x] stale page detection works
- [x] orphan page detection works
- [x] next-ingest suggestions work
- [x] targeted tests pass
- [x] full suite passes
- [x] fresh temp-dir manual upkeep smoke passes

## Validation Passes

### Pass 1

- Command: `npm test -- test/commands.test.js`
- Result: pass (30/30)

### Pass 2

- Command: `npm test -- test/cli-smoke.test.js`
- Result: pass (23/23)

### Pass 3

- Command: `npm test`
- Result: pass (98/98)

### Pass 4

- Command: fresh temp-dir manual smoke: `init -> loop -> wiki loop --json`
- Result: pass; `STATUS.md` refreshed `Last loop`, `Health`, and `Next move`, while `log.md` appended `LOOP` entries and suggested `README.md` first

## Notes

- The upkeep command is local-first and does not auto-push.
- Scheduling belongs to the next layer; this feature just makes upkeep callable and testable.

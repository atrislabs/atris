---
last_compiled: 2026-04-20
sources:
  - lib/wiki.js
  - commands/wiki.js
  - commands/init.js
  - commands/activate.js
  - commands/pull.js
  - commands/push.js
  - bin/atris.js
  - test/commands.test.js
  - atris/skills/wiki/SKILL.md
---

# Wiki — Validation

> **Status:** v2 — shipped 2026-04-07
> **Exit condition:** local-first wiki flow works, canonical root is `atris/wiki/`, init scaffolds it, activate surfaces it, agent/spec docs reference it, and this repo dogsfoods it.

## Checks

- [x] `atris ingest` scaffolds `atris/wiki/` locally
- [x] `atris query` defaults to local wiki mode
- [x] `atris lint` defaults to local wiki mode
- [x] `atris wiki search` reads `atris/wiki/index.md`
- [x] `atris wiki log` reads `atris/wiki/log.md`
- [x] `pull --only wiki` and `push --only wiki` normalize to `atris/wiki/`
- [x] `atris init` creates the wiki scaffold
- [x] `atris activate` reads `atris/wiki/STATUS.md`
- [x] A project-local wiki skill exists
- [x] Agent/spec docs mention the wiki loop
- [x] `atris-cli` itself has a seeded `atris/wiki/`

## Validation Passes

### Pass 1

- Command: `npm test -- test/commands.test.js`
- Result: pass

### Pass 2

- Command: `npm test`
- Result: pass

### Pass 3

- Command: `node bin/atris.js ingest README.md` + `query` + `lint` in a fresh temp directory
- Result: pass

### Pass 4

- Command: `npm test`
- Result: pass

### Pass 5

- Command: `node bin/atris.js ingest README.md` + scaffold check + `query` + `lint` in a second fresh temp directory
- Result: pass

### Pass 6

- Command: `npm test -- test/cli-smoke.test.js`
- Result: pass

### Pass 7

- Command: `npm test`
- Result: pass

### Pass 8

- Command: `init -> activate -> ingest -> query -> lint` in a fresh temp workspace
- Result: pass

## Notes

- Cron-driven upkeep and vibe-check interviewing are intentionally not part of v1.
- `log` and `search` stay under `atris wiki` because the top-level CLI already uses those names for journals.

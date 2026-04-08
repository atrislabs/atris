# Atris Wiki Log

## 2026-04-08

- INGEST atris-labs/goals.md -> concepts/atris-labs-goals.md
  - source: /Users/keshavrao/arena/atris-business/atris-labs/goals.md
  - durable: north star, 2026 Q2 targets ($1M ARR, 10 customers), H2 plan, standing constraints
- INGEST atris-labs top 3 sources -> wiki index/log/STATUS refreshed
  - source: /Users/keshavrao/arena/atris-business/atris-labs/atris.md
  - source: /Users/keshavrao/arena/atris-business/atris-labs/goals.md
  - source: /Users/keshavrao/arena/atris-business/atris-labs/MEMBER.md
  - index entries: syntheses/atris-labs-workspace-protocol, concepts/atris-labs-goals, systems/atris-labs
- SCAN /Users/keshavrao/arena/atris-business/atris-labs/ — picked top 3 foundational sources for ingest
  - #1 `/Users/keshavrao/arena/atris-business/atris-labs/atris.md` (57 lines) — workspace protocol, on-load sequence, layout, surfaces, north star. The operating contract for the reference implementation. → synthesis or entity page for atris-labs workspace.
  - #2 `/Users/keshavrao/arena/atris-business/atris-labs/goals.md` (32 lines) — north star, 2026 Q2 targets ($1M ARR, 10 customers), H2 plan, standing constraints. Durable company direction. → concept/entity page for atris-labs goals.
  - #3 `/Users/keshavrao/arena/atris-business/atris-labs/MEMBER.md` (39 lines) — workspace identity as a member of the Atris fleet, what it is/isn't, operating principles. Anchors the company-as-mini-AGI shape. → entity page for atris-labs (member).
  - rejected: STATUS.md (derived, decays fast), MAP.md (index, regenerable), instructions.md/persona.md/memory.md (thin, fold into entity page later), CLAUDE.md (agent harness, not durable knowledge), TODO.md (ephemeral).

## 2026-04-07

- 00:09 INGEST README.md -> seeded local repo wiki with overview and workflow pages
  - created `concepts/plan-do-review-loop.md`
  - created `syntheses/atris-cli-overview.md`
  - updated `index.md` and `STATUS.md`
- 07:50 INGEST Dorsey thesis seed pass
  - source: https://www.youtube.com/watch?v=YTVSwOY19Qs (Dorsey on Sequoia)
  - source: in-conversation reading of atris-cli (commands/, lib/wiki.js, business.js, CLAUDE.md)
  - created `entities/jack-dorsey.md`, `entities/atris-cli.md`, `entities/atris-business.md`
  - created `concepts/intent-capability-composition.md`, `concepts/wiki-as-memory-substrate.md`
  - VIOLATION: did not read existing log.md before this pass; a prior 00:09 ingest had already happened. merged afterward instead of before. lesson: `read the full source` includes the wiki's own log.
- 01:18 LOOP 10 pages, 6 stale, 1 orphan, 3 suggested
  - stale atris/wiki/entities/atris-business.md <- /Users/keshavrao/arena/atris-cli/commands/business.js
  - stale atris/wiki/entities/atris-cli.md <- /Users/keshavrao/arena/atris-cli/CLAUDE.md
  - stale atris/wiki/entities/jack-dorsey.md <- https://www.youtube.com/watch?v=YTVSwOY19Qs
  - orphan atris/wiki/syntheses/launch-post.md
  - next ingest atris/CLAUDE.md
  - next ingest atris.md
  - next ingest commands/init.js
- 01:18 LOOP 10 pages, 6 stale, 1 orphan, 3 suggested
  - stale atris/wiki/entities/atris-business.md <- /Users/keshavrao/arena/atris-cli/commands/business.js
  - stale atris/wiki/entities/atris-cli.md <- /Users/keshavrao/arena/atris-cli/CLAUDE.md
  - stale atris/wiki/entities/jack-dorsey.md <- https://www.youtube.com/watch?v=YTVSwOY19Qs
  - orphan atris/wiki/syntheses/launch-post.md
  - next ingest atris/CLAUDE.md
  - next ingest atris.md
  - next ingest commands/init.js

# Atris Wiki Log

## 2026-04-27

- PRODUCT MEMORY owner -> computer model -> `concepts/owner-computer-model.md`
  - durable: keep `business` as the shared owner in schema, but explain the product as owners having typed computers
  - model: `Owner = User | Business`; `Computer = workspace + files + tools + secrets + memory + agents + validation/RL loop`
  - implication: `atris business init` creates a business owner plus the first/default business computer; future `atris computer create <type>` can add typed computers under the owner
  - updated `systems/atris-business.md` and `index.md`

## 2026-04-08

- INGEST atris-labs/MEMBER.md -> systems/atris-labs.md
  - source: /Users/keshavrao/arena/atris-business/atris-labs/MEMBER.md
  - durable: company-as-workspace identity, what atris-labs is/isn't, operating principles, fleet position
  - linked from index.md (Entities)
- INGEST atris-labs/goals.md -> concepts/atris-labs-goals.md
  - source: /Users/keshavrao/arena/atris-business/atris-labs/goals.md
  - durable: north star, 2026 Q2 targets ($1M ARR, 10 customers), H2 plan, standing constraints
- INGEST atris-labs top 3 sources -> wiki index/log/STATUS refreshed
  - source: /Users/keshavrao/arena/atris-business/atris-labs/atris.md
  - source: /Users/keshavrao/arena/atris-business/atris-labs/goals.md
  - source: /Users/keshavrao/arena/atris-business/atris-labs/MEMBER.md
  - index entries: briefs/atris-labs-workspace-protocol, concepts/atris-labs-goals, systems/atris-labs
- SCAN /Users/keshavrao/arena/atris-business/atris-labs/ — picked top 3 foundational sources for ingest
  - #1 `/Users/keshavrao/arena/atris-business/atris-labs/atris.md` (57 lines) — workspace protocol, on-load sequence, layout, surfaces, north star. The operating contract for the reference implementation. → brief or entity page for atris-labs workspace.
  - #2 `/Users/keshavrao/arena/atris-business/atris-labs/goals.md` (32 lines) — north star, 2026 Q2 targets ($1M ARR, 10 customers), H2 plan, standing constraints. Durable company direction. → concept/entity page for atris-labs goals.
  - #3 `/Users/keshavrao/arena/atris-business/atris-labs/MEMBER.md` (39 lines) — workspace identity as a member of the Atris fleet, what it is/isn't, operating principles. Anchors the company-as-mini-AGI shape. → entity page for atris-labs (member).
  - rejected: STATUS.md (derived, decays fast), MAP.md (index, regenerable), instructions.md/persona.md/memory.md (thin, fold into entity page later), CLAUDE.md (agent harness, not durable knowledge), TODO.md (ephemeral).

## 2026-04-07

- 00:09 INGEST README.md -> seeded local repo wiki with overview and workflow pages
  - created `concepts/plan-do-review-loop.md`
  - created `briefs/atris-cli-overview.md`
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
  - orphan atris/wiki/briefs/launch-post.md
  - next ingest atris/CLAUDE.md
  - next ingest atris.md
  - next ingest commands/init.js
- 01:18 LOOP 10 pages, 6 stale, 1 orphan, 3 suggested
  - stale atris/wiki/entities/atris-business.md <- /Users/keshavrao/arena/atris-cli/commands/business.js
  - stale atris/wiki/entities/atris-cli.md <- /Users/keshavrao/arena/atris-cli/CLAUDE.md
  - stale atris/wiki/entities/jack-dorsey.md <- https://www.youtube.com/watch?v=YTVSwOY19Qs
  - orphan atris/wiki/briefs/launch-post.md
  - next ingest atris/CLAUDE.md
  - next ingest atris.md
  - next ingest commands/init.js

## 2026-04-09
- INGEST README.md + autopilot reward rail -> concepts/verifiable-reward-loop.md
  - source: README.md
  - source: atris/TODO.md
  - source: commands/autopilot.js
  - source: lib/scorecard.js
  - source: .atris/presidio/scorecards.md
  - durable: Atris should underpromise publicly as a verifiable feedback loop and keep live scorecards in Presidio
- RECOMPILE briefs/atris-cli-overview.md and systems/atris-cli.md for the reward rail
  - source: README.md
  - source: commands/autopilot.js
  - source: lib/scorecard.js
  - source: atris/TODO.md
  - durable: the CLI overview and system page now explain verify commands, reward blocks, scorecards, and the Presidio split in one place
- MOVE flywheel scorecards to Presidio
  - source: .gitignore
  - source: lib/scorecard.js
  - durable: scorecards are local operating memory and should not live in the tracked repo
- 19:12 LOOP 11 pages, 7 stale, 1 orphan, 3 suggested
  - stale atris/wiki/people/jack-dorsey.md <- https://www.youtube.com/watch?v=YTVSwOY19Qs
  - stale atris/wiki/systems/atris-business.md <- /Users/keshavrao/arena/atris-cli/commands/business.js
  - stale atris/wiki/systems/atris-cli.md <- /Users/keshavrao/arena/atris-cli/CLAUDE.md
  - orphan atris/wiki/briefs/launch-post.md
  - next ingest atris/CLAUDE.md
  - next ingest commands/init.js
  - next ingest commands/activate.js

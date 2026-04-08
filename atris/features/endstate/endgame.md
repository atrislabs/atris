# Project Endstate — Endgame

HORIZON
  Within 6 days, a cold operator can run two pinned packs from `atris-cli`
  against the same `atris-cli` + `../atrisos-backend` snapshots and see a
  clear winner on reviewed completion, tests, artifact completeness, and
  intervention count.

IDENTITY
  We are a systems shop, not a model fan club.
  We win by making capabilities legible, memory compound, and runs reproducible.

GAP
  ALREADY TRUE
    - [[atris/wiki/systems/atris-cli.md]] gives `autopilot`, `experiments`,
      `wiki`, and `loop` as the local harness primitives.
    - [[atris/wiki/concepts/plan-do-review-loop.md]] makes reviewed outcome the
      unit of truth instead of chat confidence.
    - [[atris/wiki/concepts/wiki-as-memory-substrate.md]] gives a place to
      track pre/post-run memory state as part of the score.
    - [[atris/wiki/concepts/intent-capability-composition.md]] already names
      the unlock: legible capabilities make the roadmap come from gaps.
    - `atris/features/endstate/contract.md` now pins the Level 1 task pair,
      time budget, operator rules, and scorecard.
    - `atris/features/endstate/artifact-schema.json` now defines the shared
      evidence bundle both runs must emit.
    - Runnable `endstate-baseline` / `endstate-stack` packs now exist under
      `atris/experiments/`.
  NOT YET
    - No snapshot pinning step writes the exact repo commits into artifacts yet.
    - No scoring script turns the artifact bundle into the Level 1 scorecard.
    - No runner emits the shared artifact bundle automatically.
    - No published head-to-head result exists yet.

REVERSE PATH
  ENDGAME
    <- publish one rerunnable result with artifacts and a declared winner
    <- run `endstate-stack` on the same rubric
    <- run `endstate-baseline` on the same snapshots and budget
    <- instrument one shared artifact schema
    <- scaffold `endstate-baseline` + `endstate-stack` from `atris experiments`
    <- eliminate fuzzy language and internal codenames from public docs
    <- freeze Level 1 around one CLI task + one backend task this week

NEXT MOVE
  Teach both Endstate runners to write `artifact-schema.json` payloads,
  including repo commits, tests, review result, wiki delta, elapsed time, and
  intervention count, into a shared artifacts location.
  Why this first: the contract and schema exist now, so runner emission is the
  next bottleneck between planning and a real scored matchup.

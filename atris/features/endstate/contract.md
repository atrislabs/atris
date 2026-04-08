# Project Endstate — Level 1 Contract

> **Status:** draft
> **Created:** 2026-04-08
> **Last Updated:** 2026-04-08

---

## Goal

Compare one pinned single-model baseline against one coordinated stack run on the same bounded task pair, repo snapshots, and review bar. This is a system benchmark, not a raw model benchmark.

---

## Tracks

### Track A — `atris-cli`

- **Task:** `capabilities.md generator`
- **Intent:** make the CLI capability surface legible so composition gaps become visible
- **Source context:** `atris/wiki/systems/atris-cli.md`, `atris/wiki/concepts/intent-capability-composition.md`

### Track B — `../atrisos-backend`

- **Task:** `Task 8: Hourly validator loop`
- **Intent:** align `scripts/evolve.py` with the self-improving core in one bounded backend slice
- **Source context:** `../atrisos-backend/atris/TODO.md`, `../atrisos-backend/atris/MAP.md`

---

## Run Rules

- Same starting snapshots for both repos across both runs
- Same task brief across baseline and stack
- Same hard time budget: 90 minutes total
- Same review bar: reviewed completion beats raw diff volume
- No manual code edits during either run
- Allowed operator input:
  - one kickoff prompt
  - one clarification reply per repo only if the run blocks on a missing fact
- Any extra steering, edits, or hidden rescue work counts as intervention

---

## Artifact Bundle

Each run must emit:

- repo commits used
- task brief used
- prompt/context given to the system
- changed files
- tests run and pass/fail result
- review result
- wiki delta or `not_applicable`
- elapsed time
- intervention count

Schema source of truth: `atris/features/endstate/artifact-schema.json`

---

## Scorecard

Total = 100

- Reviewed completion: 40
- Test outcome: 25
- Artifact completeness: 15
- Wiki/memory update captured: 10
- Operator load: 10

Tiebreakers:

1. fewer interventions
2. cleaner review result
3. faster completion

---

## Win Condition

The stack wins Level 1 if it beats the baseline on total score and does not lose the reviewed completion category.

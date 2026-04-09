---
name: Horizon Type Categorization
description: Naming convention and type inference for endgame horizons
type: system-guide
last_compiled: 2026-04-09
sources:
  - /Users/keshavrao/arena/atris-cli/lib/scorecard.js:1-53
  - /Users/keshavrao/arena/atris-cli/commands/autopilot.js:1054-1080
  - /Users/keshavrao/arena/atris-cli/atris/features/
---

# Horizon Type Categorization

When an endgame closes, a scorecard is written to `atris/scorecards.md`. When `/endgame` picks the next horizon, `scoreEndgameCandidates()` reads past scorecards and **infers the horizon type from the slug** to calculate historical reward means. The type inference is **prefix-based**: it splits the slug on the first `-` and uses the left side as the type.

## Current Implementation

**Type Extraction Logic** (`commands/autopilot.js:1057`):
```javascript
const type = sc.slug.split('-')[0];  // "loop-self-seeds-horizons" → "loop"
```

**Scorecard Format** (`lib/scorecard.js:46-49`):
```
- **[date] slug** — shipped: X/Y — wall-clock: Nh — halt: Z% — reward: total — lessons: N
```

Example:
```
- **[2026-04-08] loop-self-seeds-horizons** — shipped: 4/4 — wall-clock: 6.0h — halt: 0% — reward: 24 — lessons: 3
```

## Proposed Type Convention

To make horizon type inference predictable and useful for historical weighting, slugs should follow this prefix pattern:

| Type | Pattern | Purpose | Examples |
|------|---------|---------|----------|
| **wiki** | `wiki-*` | Knowledge capture, documentation, system models | `wiki-for-atrisos-web`, `wiki-rl-environment` |
| **loop** | `loop-*` | Automation, self-improvement, meta-level system changes | `loop-self-seeds-horizons`, `loop-validator-learns` |
| **verify** | `verify-*` | Quality assurance, validation, test coverage, ref healing | `verify-cli-refs`, `verify-endgame-scoring` |
| **refactor** | `refactor-*` | Code restructuring, pattern extraction, technical debt | `refactor-auth-duplication`, `refactor-todo-parser` |
| **feature** | `feature-*` | User-facing capability, new command, workflow extension | `feature-wiki-ingest`, `feature-autopilot` |
| **fix** | `fix-*` | Bug fixes, edge cases, incident response | `fix-inbox-parser-bug`, `fix-token-refresh` |
| **skill** | `skill-*` | New SKILL.md, agent capability, human interface | `skill-endgame-horizon-picking`, `skill-wiki-query` |

## Known Edge Cases

1. **Suffix-based types:** Some horizons end with the type word (e.g., `verifiable-reward-loop` ends with "loop"). The current prefix-only logic would infer type "verifiable" instead of "loop". This is an inconsistency to fix via validation rules (see T3).

2. **Hyphenated types:** Future horizons might have multi-word types like `wiki-memory-ingest` (prefix would be "wiki", which is correct). However, `verify-and-fix-refs` would infer type "verify", which is correct. No conflicts observed in feature list yet.

3. **Single-word slugs:** A slug like `autopilot` (no dashes) would infer type "autopilot", creating a new type every time. Current codebase avoids this; all released horizons use at least one dash.

## Scorecard Parsing

The `readScorecards()` function (`lib/scorecard.js:90-124`) parses the append-only line format and returns:
```javascript
{
  endDate,           // ISO date "2026-04-08"
  slug,              // "loop-self-seeds-horizons"
  tasksShipped,      // number
  tasksAttempted,    // number
  wallClockHours,    // float (parsed from "6.0h" or "120m")
  haltRatio,         // 0.0 to 1.0
  totalReward,       // integer
  lessonsGenerated   // integer
}
```

## Historical Reward Calculation

When picking the next endgame, `scoreEndgameCandidates()` calculates mean reward per type:

1. **Last 10 scorecards** are loaded
2. **Type is extracted** from each slug (prefix before first dash)
3. **Mean reward per type** is calculated across all scorecards of that type
4. **Each candidate is scored** as: `expectedValue = historicalMean × confidence`
5. **80/20 split:** 80% exploit (highest expected value), 20% explore (random)

## Validation Rules (for T3)

These rules should be enforced when /endgame suggests new candidates:

1. **Slug must match type pattern:** `^(wiki|loop|verify|refactor|feature|fix|skill)-[\w-]+$`
2. **Prefix extracts as registered type:** Slug split on first `-` yields a known type
3. **No type suffix without explicit handling:** If a slug ends with a type word (e.g., `-loop`), document the intended type explicitly in the task context, don't infer from suffix
4. **Single-dash minimum:** All production slugs use at least one dash

## References

- **Scorecard writing:** `lib/scorecard.js:20-53` (`writeScorecard`)
- **Scorecard parsing:** `lib/scorecard.js:90-124` (`readScorecards`)
- **Type inference & scoring:** `commands/autopilot.js:1038-1112` (`scoreEndgameCandidates`)
- **Endgame picking:** `commands/autopilot.js:207` (calls `scoreEndgameCandidates`)
- **Endgame spec:** `atris/skills/endgame/SKILL.md` (slug format rules)

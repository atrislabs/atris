---
type: concept
slug: horizon-types
title: Horizon Type Categorization
sources: [/Users/keshavrao/arena/atris-cli/commands/autopilot.js:1038-1112, /Users/keshavrao/arena/atris-cli/lib/scorecard.js, /Users/keshavrao/arena/atris-cli/atris/skills/endgame/SKILL.md]
created: 2026-04-09
updated: 2026-04-09
tags: [horizon, endgame, type-system, autopilot]
---

# Horizon Type Categorization

A **horizon** is the target state an endgame pursues. The horizon slug (e.g., `loop-self-seeds-horizons`, `wiki-for-atrisos-web`) encodes its type in a **prefix convention** — the first segment before the first dash defines the category.

## Type Prefix System

The `scoreEndgameCandidates` function (`commands/autopilot.js:1054-1057`) infers type by taking the slug's first segment:

```javascript
const type = sc.slug.split('-')[0];
```

Example decodings:

| Slug | Type | Category |
|---|---|---|
| `loop-self-seeds-horizons` | `loop` | Automation/Loop Enhancement |
| `wiki-for-atrisos-web` | `wiki` | Knowledge/Memory System |
| `verifiable-reward-loop` | `verifiable` | Quality/Verification |
| `refactor-cli-output` | `refactor` | Code Refactoring |
| `verify-map-refs` | `verify` | Verification/Validation |

## Known Horizon Types

### `loop-*` — Automation & Heartbeat Work

**Purpose:** Enhance the autopilot loop, idle detection, self-seeding, or recurrence patterns.

**Examples:**
- `loop-self-seeds-horizons` — self-seeding machinery, idle detection, candidate imaginer
- Task context: Shipped M1-M4 milestones; closed endgame 2026-04-09

**Scope:** Changes to `commands/autopilot.js`, `commands/run.js`, recurrence logic, horizon candidate generation.

---

### `wiki-*` — Knowledge & Memory Systems

**Purpose:** Build or extend the wiki substrate (`atris/wiki/`), knowledge compilation, page ingestion, or memory contracts.

**Examples:**
- `wiki-for-atrisos-web` — initial wiki build for atrisos-web project; completed with T1–T4e
- Task context: Shipped T1–T4e, C15–C55; shipped 2026-04-08

**Scope:** Changes to `lib/wiki.js`, `commands/wiki.js`, ingest/query/lint verbs, page templates, index.md.

---

### `verify-*` — Quality & Validation

**Purpose:** Add deterministic checks, verification fields, test harnesses, or validator-phase enhancements.

**Examples:**
- `verify-map-refs` — auto-heal drifted MAP.md line references; proposed but not yet active endgame
- Task context: Mentioned in `/endgame` SKILL.md as example verify-and-fix pattern

**Scope:** Changes to validator phase, `commands/clean.js` healing logic, `verify:` field execution, test runners.

---

### `refactor-*` — Code Refactoring & Cleanup

**Purpose:** Improve code quality, reduce duplication, extract helpers, reorganize modules without changing external behavior.

**Examples:**
- Not yet shipped; reserved for major cleanup efforts

**Scope:** Internal code reorganization, no new features; must preserve all external APIs and behaviors.

---

### `human-*` — Human Interaction & Output

**Purpose:** Improve CLI output, user-facing messaging, decision points, or operator experience.

**Examples:**
- `human-output` — audit and rewrite autopilot/status/validator output for non-technical readers; active planning 2026-04-08

**Scope:** Changes to `commands/autopilot.js` output surfaces, `commands/status.js`, `commands/workflow.js` review/plan/do banners.

---

### `agent-*` — Multi-Agent Coordination

**Purpose:** Add file locks, dependency graphs, conflict arbitration, or agent collision prevention.

**Examples:**
- `agent-coordinator` — file-claim locks, TTL-based stale detection, first-claimer-wins arbitration; active planning 2026-04-08

**Scope:** New `commands/claim.js`, `commands/release.js`, `.atris/locks/` storage, collision detection.

---

### Compound/Domain-Specific Types

Some horizons use non-standard prefixes:

- `verifiable-reward-loop` — type = `verifiable` (emphasizes a quality attribute, not a system component)
  - Context: Current endgame (picked 2026-04-09). Scorecards + per-tick reward scoring + verify-field wiring.
  - Pattern: When the horizon's identity is better captured by an adjective (e.g., "making the loop verifiable" vs. "enhancing the loop mechanism"), use the adjective as the type prefix.

## Type Inference Rules

1. **Extract type:** Split slug on first `-` and take the first segment.
   ```javascript
   const type = slug.split('-')[0];
   ```

2. **Lowercase for comparison:** Candidate titles and slugs are normalized to lowercase when scoring.
   ```javascript
   const cType = c.title.split('-')[0].toLowerCase();
   ```

3. **Historical scoring:** Once scorecards accumulate, `/endgame` and `/autopilot` use historical mean reward per type to weight candidate horizons (80/20 exploit/explore split in `scoreEndgameCandidates`).

## Convention & Validation

- **No internal dashes in type prefix:** The type is always the segment before the first `-`. If a horizon needs multi-word semantics (e.g., "verify-and-fix"), the prefix is still just `verify`.
- **Case sensitivity:** Types are stored and compared as lowercase.
- **New type creation:** When proposing a new endgame, if the prefix is a novel type not in the Known Types table, mention it in the NEXT MOVE section so the validator can flag it for docs update.

## Scorecard Contract

When an endgame closes, a scorecard is written to `.atris/presidio/scorecards.md` with the format:

```markdown
- **[YYYY-MM-DD] slug** — shipped: N/M — wall-clock: Xh — halt: Z% — reward: R — lessons: L
```

The slug is the source of truth for type inference. The `totalReward` field (R) is the metric used to calculate historical mean reward per type.

## Future Evolution

- **Type-aware validation:** T3 proposes adding type-validation rules to `/endgame` so novel types are flagged before being queued.
- **Type registry:** If prefix-only inference breaks down (e.g., too many false positives or ambiguous two-word prefixes), add an explicit `types.json` registry mapping slugs → canonical types.
- **Reward weighting refinement:** As more scorecards accumulate, the exploit/explore ratio may be tuned per type (e.g., `wiki-*` horizons might have lower variance, allowing higher exploit percentage).

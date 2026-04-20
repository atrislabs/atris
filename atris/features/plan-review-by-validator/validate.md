# Validation — plan-review-by-validator

> **Role:** System Validation Script
> **Rule:** If ANY step fails, the feature is broken.

## preflight

```bash
# The machine-checkable rubric for this feature.
# Passes iff the plan-review phase is live and the test suite is green.

set -e

# 1. runPlanReview is exported.
node -e "const m = require('./commands/autopilot'); if (typeof m.runPlanReview !== 'function') { console.error('runPlanReview not exported'); process.exit(1); }"

# 2. parseVerdict is exported (required for downstream tools to replay verdicts).
node -e "const m = require('./commands/autopilot'); if (typeof m.parseVerdict !== 'function') { console.error('parseVerdict not exported'); process.exit(1); }"

# 3. atris.md documents the plan-review phase.
grep -q "plan-review" atris.md

# 4. Validator MEMBER.md names the plan-review responsibility and the SIGNOFF format.
grep -q "Plan-review" atris/team/validator/MEMBER.md
grep -q "SIGNOFF" atris/team/validator/MEMBER.md

# 5. runTaskOnce has the plan-rejected-at-review halt path.
grep -q "plan-rejected-at-review" commands/autopilot.js

# 6. Test suite green.
node --test test/autopilot-plan-review.test.js > /tmp/atris-plan-review-suite.log 2>&1
grep -qE "(pass|ℹ pass) 9" /tmp/atris-plan-review-suite.log
grep -qE "(fail|ℹ fail) 0" /tmp/atris-plan-review-suite.log
```

## simulation steps

### 1. SIGNOFF proceeds

- **Action:** Stub validator to return `SIGNOFF: ...`. Invoke `runPlanReview`.
- **Expect:** `verdict: 'SIGNOFF'`, `signers: ['validator']`.

### 2. REJECT halts and journals

- **Action:** Stub validator to return `REJECT: reason\nFIX: fix`. Invoke `runTaskOnce` with `skipFalsifiability: true` and stubbed `phaseExec`.
- **Expect:** `outcome: 'halted'`, `reason: 'plan-rejected-at-review'`. Today's journal contains "Plan rejected". `lessons.md` does NOT contain "plan-rejected".

### 3. Codex opt-in but absent

- **Action:** Pass `tags: ['codex']` and `hasCodex: false`. Stub validator to SIGNOFF.
- **Expect:** `verdict: 'SIGNOFF'`, `signers: ['validator']`, `notes` mentions "not on PATH".

### 4. Codex disagreement surfaces both

- **Action:** Pass `tags: ['codex']` and `hasCodex: true`. Stub validator to SIGNOFF, codex to REJECT.
- **Expect:** `verdict: 'REJECT'`, `split: true`, `signers: ['validator', 'codex']`. `reason` contains both verdicts.

## regression check

- [ ] M1 (`test/autopilot-verify-falsifiability.test.js`) still 8/8 green.
- [ ] `atris autopilot --dry-run` does not falsely reject plan-review on reactive ticks (they skip the gate because `context.kind !== 'endgame'` or equivalent).
- [ ] `atris update --all --dry-run` still scans cleanly (no import or export regressions).

**Status:** Verified — 2026-04-19

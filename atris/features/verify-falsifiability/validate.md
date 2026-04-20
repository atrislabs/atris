# Validation — verify-falsifiability

> **Role:** System Validation Script
> **Rule:** If ANY step fails, the feature is broken.

## preflight

```bash
# The machine-checkable rubric for this feature.
# Passes iff the falsifiability gate is live and the test suite is green.

set -e

# 1. verifyRubric is exported and the CLI route exists.
node -e "const m = require('./commands/verify'); if (typeof m.verifyRubric !== 'function') { console.error('verifyRubric not exported'); process.exit(1); }"

# 2. atris.md carries the Verify constraint.
grep -q "Verify cannot be a raw shell shortcut" atris.md

# 3. runTaskOnce has the falsifiability gate.
grep -q "verify-not-falsifiable" commands/autopilot.js

# 4. Test suite green.
node --test test/autopilot-verify-falsifiability.test.js > /tmp/atris-verify-suite.log 2>&1
grep -qE "(pass|ℹ pass) 8" /tmp/atris-verify-suite.log
grep -qE "(fail|ℹ fail) 0" /tmp/atris-verify-suite.log
```

## simulation steps

### 1. trivial Verify is rejected

- **Action:** Create a task with `Verify: true`, invoke `runTaskOnce` with `{ kind: 'endgame' }`.
- **Expect:** `outcome: halted`, `reason: verify-not-falsifiable`, lesson written to `lessons.md`.

### 2. real Verify proceeds past the gate

- **Action:** Create a task with `Verify: test -f file-that-doesnt-yet-exist`, invoke `runTaskOnce` with `{ kind: 'endgame' }`.
- **Expect:** `outcome` is anything other than `halted` with reason `verify-not-falsifiable`. Gate allowed the tick through.

### 3. reactive kinds are exempt

- **Action:** Same trivial `Verify: true`, but `kind: 'inbox'`.
- **Expect:** Gate does not fire. (Tick may still halt for unrelated reasons — the claude CLI spawn — but not for `verify-not-falsifiable`.)

### 4. `atris verify <slug> --section` round-trip

- **Action:** `atris verify verify-falsifiability --section preflight`
- **Expect:** Exit 0. All four preflight assertions pass.

## regression check

- [ ] Existing `atris verify` (no args) still prints the workspace health box.
- [ ] Existing `atris verify <task-id>` still verifies a task from TODO.md.
- [ ] `atris autopilot --dry-run` does not falsely report `verify-not-falsifiable` on reactive ticks.
- [ ] `atris update --all --dry-run` still scans all 45 projects cleanly.

**Status:** Verified — 2026-04-19

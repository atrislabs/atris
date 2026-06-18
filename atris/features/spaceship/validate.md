# Validation — Spaceship

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If ANY step fails, the feature is broken.

---

## 1. Environment Check

- [x] **Pre-flight**
  - Command: `node --test test/spaceship-supervisor.test.js`
  - Expect: `pass 1`, `fail 0`

---

## 2. Simulation Steps (The "Real" Test)

### Step 1: Survives halts (happy + failure path)

- **Action:** `bash scripts/spaceship.sh --repo <tmp-git> --hours 0.003 --interval 1 --tick-cmd <ship/idle/halt/halt/idle stub> --no-email`
- **Expect:** log shows `tick 1 SHIPPED`, `tick 3 HALTED`, `tick 4 HALTED`, then continues and reaches `spaceship done` — it did not exit on the first halt.

### Step 2: Alert thresholds

- **Action:** same run.
- **Expect:** `ticks halted in a row` fires at halt-streak 2; `backlog looks empty` fires once at idle-streak 3 (never duplicates).

### Step 3: Live channel

- **Action:** `printf 'x' | venv/bin/python backend/scripts/spaceship_update.py --subject test`
- **Expect:** `OK <ses-message-id>` for each recipient.

---

## 3. Regression Check

- [x] `node -c bin/atris.js` clean; `atris --version` and `atris spaceship --help` work (CLI dispatch intact).
- [x] `atris pulse status --json` still returns (read-only reporter does not perturb the loop).
- [x] Backend security scanner: PASS, 0 findings.

---

**Status:** Verified

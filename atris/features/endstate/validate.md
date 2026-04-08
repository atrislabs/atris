# Validation — Project Endstate

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If the benchmark cannot be rerun and scored from the artifacts alone, the feature is broken.
> **Exit condition:** A cold operator can run the dry-run benchmark commands below, see receipt artifacts land in both Endstate packs, and watch the focused test suite pass.

---

## 1. Shipped Checks

- [ ] **Baseline dry-run receipt**
  - Command: `node bin/atris.js experiments run endstate-baseline --dry-run`
  - Expect: prints `Endstate baseline run recorded`, writes one JSON receipt under `atris/experiments/endstate-baseline/artifacts/`, appends one `results.tsv` row, and keeps `changed_files` empty in dry-run.

- [ ] **Stack dry-run receipt**
  - Command: `node bin/atris.js experiments run endstate-stack --dry-run`
  - Expect: prints `Endstate stack run recorded`, writes one JSON receipt under `atris/experiments/endstate-stack/artifacts/`, appends one `results.tsv` row, and uses the same shared schema as baseline.

- [ ] **Focused harness tests**
  - Command: `node --test test/experiments.test.js`
  - Expect: green coverage for generic `experiments run`, `endstate-baseline` dry-run receipt writing, `endstate-stack` dry-run receipt writing, and benchmark prompt rendering.

---

## 3. Regression Check

- [ ] Verify `atris autopilot` still works outside the benchmark flow.
- [ ] Verify `atris experiments validate` still works on existing packs.
- [ ] Verify wiki state refresh still works after benchmark runs.
- [ ] Verify a cold reader can rerun the benchmark from docs plus artifacts alone.

---

**Status:** v1 — shipped 2026-04-08

# Validation — Project Endstate

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If the benchmark cannot be rerun and scored from the artifacts alone, the feature is broken.
> **Exit condition:** A cold operator can run the dry-run benchmark commands below, see receipt artifacts land in both Endstate packs, and watch the focused test suite pass. Clean-room replay from docs plus artifacts alone is tracked separately below.

---

## 1. Shipped Checks

- [x] **Baseline dry-run receipt**
  - Command: `node bin/atris.js experiments run endstate-baseline --dry-run`
  - Result: PASS on 2026-04-08 — prints `Endstate baseline run recorded`, writes a new JSON receipt under `atris/experiments/endstate-baseline/artifacts/`, appends one `results.tsv` row, keeps `changed_files` empty in dry-run, and records runner `baseline-single`.

- [x] **Stack dry-run receipt**
  - Command: `node bin/atris.js experiments run endstate-stack --dry-run`
  - Result: PASS on 2026-04-08 — prints `Endstate stack run recorded`, writes a new JSON receipt under `atris/experiments/endstate-stack/artifacts/`, appends one `results.tsv` row, keeps `changed_files` empty in dry-run, records runner `stack-coordinated`, and uses the same shared schema as baseline.

- [x] **Focused harness tests**
  - Command: `node --test test/experiments.test.js`
  - Result: PASS on 2026-04-08 — green coverage for generic `experiments run`, `endstate-baseline` dry-run receipt writing, `endstate-stack` dry-run receipt writing, and benchmark prompt rendering.
  - Safety net: `npm test` also passes on 2026-04-08 (`132/132`).

- [x] **Receipt comparison**
  - Command: `node bin/atris.js experiments compare endstate`
  - Result: PASS on 2026-04-08 — reads the latest baseline + stack artifacts, prints the side-by-side scorecard, and declares `no winner yet` for the current dry-run state instead of forcing the operator to hand-score receipts.

- [x] **One-command rehearsal**
  - Command: `node bin/atris.js experiments replay endstate`
  - Result: PASS on 2026-04-08 — validates both packs, emits fresh dry-run receipts, compares the latest result, and leaves the operator with one end-to-end public rehearsal command.

---

## 2. Regression Check

- [x] Verify `atris autopilot` still works outside the benchmark flow.
  - Command: `node bin/atris.js autopilot --dry-run --auto --iterations=1`
  - Result: PASS on 2026-04-08 — the loop selected the active benchmark-doc task, printed a dry-run next-step brief, and exited cleanly with `0 tasks in 0s`.
- [x] Verify `atris experiments validate` still works on existing packs.
  - Commands: `node bin/atris.js experiments validate endstate-baseline`; `node bin/atris.js experiments validate endstate-stack`
  - Result: PASS on 2026-04-08 — both packs validate cleanly.
- [x] Verify the documented quickstart works from a fresh workspace.
  - Command: `node --test test/experiments.test.js`
  - Result: PASS on 2026-04-08 — the suite now includes both `documented benchmark quickstart works from a fresh workspace` and `experiments replay endstate runs the public rehearsal flow`, so the public step-by-step and one-command rehearsal are both exercised in temp workspaces (`13/13` in the focused suite).
- [x] Verify wiki state refresh still works after benchmark runs.
  - Command: `node bin/atris.js loop`
  - Result: PASS on 2026-04-08 — wiki upkeep completed, refreshed status/log output, and surfaced the next stale pages and ingest candidates.
- [ ] Verify a cold reader can rerun the benchmark from docs plus artifacts alone.
  - Pending: fresh-workspace replay is covered by test now; the remaining gap is a third-party clean-room run outside the authoring session with only the checked-in docs plus emitted receipts.

---

## Status

v2 — harness re-verified 2026-04-08
Exit condition: both dry-run receipts land, the compare command can score the latest receipts, the replay command can rehearse the full public flow, focused benchmark tests pass, autopilot dry-run still works, experiments validate still works, and wiki upkeep still refreshes state.

v1 — shipped 2026-04-08

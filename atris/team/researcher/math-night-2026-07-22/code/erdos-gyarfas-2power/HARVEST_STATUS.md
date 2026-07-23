# HARVEST_STATUS — Erdos-Gyarfas n=36 girth>=7 (harvested 2026-07-23, second harvester)

Context: the first harvester died without reporting. Raw run data lives in the
session scratchpad, not this directory:
`/private/tmp/claude-501/-Users-keshavrao-arena-atris-cli/fd403b33-f912-4822-af2b-bf1a10d0935d/scratchpad/erdos-gyarfas-2power/`
Durable copies of the raw evidence are now in `harvest/` here.

## Status: exhaustion COMPLETE, zero survivors. Near-miss recovery RESTARTED (was dead).

### Main sweep — complete and verified by this harvester
- 8/8 shard generator logs (gen36g7_0..7.log) end "All done ... CPU time".
- 8/8 filter stats logs (stats36g7_0..7.log) present with STATS lines.
- Shard totals: 11,057,343 / 11,518,401 / 10,931,495 / 10,884,399 / 10,945,277 /
  13,092,438 / 12,711,999 / 13,937,731. Sum re-computed = 95,079,083.
- OEIS cross-check: A014375(18) = 95,079,083 (connected cubic graphs on 36
  vertices, girth >= 7). Fetched from oeis.org b-file by this harvester: exact match.
- Survivors: all 8 surv36g7_*.g6 files are 0 bytes (re-checked). Zero graphs
  with no C4/C8/C16/C32. NO COUNTEREXAMPLE.
- Filter validation re-checked: cls_c.txt vs cls_py.txt byte-identical
  (cmp, 6,168 graphs); sample36_c.txt vs sample36_py.txt byte-identical
  (cmp, 120 graphs). filter.c agrees with the pure-python exact detector.

### Near-miss recovery — the one discrepancy found in RESULTS_36G7.md
- stats36g7_5.log shows noC4C8=1: exactly one shard-5 graph has no C8
  (it contains a C16, since noC4C8C16=0), so the conjecture verdict is
  unaffected either way.
- RESULTS_36G7.md claims this graph was "Recovered ... (see c8free36_s5.g6)
  and independently re-verified". That claim was NOT backed by artifacts at
  harvest time: c8free36_s5.g6 was 0 bytes and regen36g7_5.log showed a
  filter_c8dump re-run that died seconds after starting at 06:59:54 (same
  mtime on both files; no processes alive). The first harvester evidently
  died mid-recovery.
- Action taken: restarted the recovery at 2026-07-23 ~07:5x local,
  `nice -n 15 snarkhunter-64 36 7 s o g m 5 8 | nice -n 15 ./filter_c8dump
  > c8free36_s5.g6` (in the scratchpad dir). Estimated < 30 min wall
  (original shard-5 gen: 690 s CPU). filter_c8dump flushes the graph to the
  file the moment it is found.
- Verification plan on completion (do this before trusting the near-miss line):
  pipe c8free36_s5.g6 through crosscheck.py (exact python detector) and
  expect `<g6> 0 0 1` (no C4, no C8, has C16); also confirm the regen STATS
  line reproduces total=13092438 noC4C8=1. Then copy c8free36_s5.g6 and both
  regen logs into `harvest/`.

## Verdict
- The headline result in RESULTS_36G7.md is confirmed against raw shard data:
  all 95,079,083 cubic girth>=7 graphs on 36 vertices contain a cycle of
  length 4, 8, 16, or 32. No counterexample.
- The near-miss recovery artifact was missing (dead run); regen is in flight.
  Until c8free36_s5.g6 is non-empty and crosschecked, treat the "recovered and
  re-verified" sentence in RESULTS_36G7.md as unproven; everything else there
  was independently re-checked and is accurate.

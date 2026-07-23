# HARVEST_STATUS — Hajos round 5 (harvested 2026-07-23, second harvester)

Context: the first harvester died without reporting. This harvest re-located the
raw run data (it lives in the session scratchpad, not this directory), re-ran the
aggregator from scratch, and re-checked every claim in RESULTS_ROUND5.md against
raw artifacts. Raw evidence is now durably copied into `harvest/` here.

Raw data location (volatile scratchpad, now mirrored to `harvest/`):
`/private/tmp/claude-501/-Users-keshavrao-arena-atris-cli/fd403b33-f912-4822-af2b-bf1a10d0935d/scratchpad/hajos-cycle-decomposition/`

## Status: COMPLETE — both classes exhausted, no counterexample

- Sentinel `r5_all_done.txt` present, content `ALLDONE`.
- Exit files: 20/20 shards `exit 0` (10 reg8n14 + 10 reg10n15).
- All 20 shard logs end in `DONE CLEAN`, `escal=0 unknown=0`.
- No sweep processes running; nothing left to restart.

## Harvested totals (tally.py re-run by this harvester, 2026-07-23)

Class 1 — 8-regular graphs on n=14 (bound: floor(13/2) = 6 cycles):

    files=10 done_shards=10 total=3459386 escal=0 unknown=0
    hist= {4: 1633554, 5: 1501579, 6: 324253}

Class 2 — 10-regular graphs on n=15 (bound: floor(14/2) = 7 cycles):

    files=10 done_shards=10 total=805579 escal=0 unknown=0
    hist= {5: 355085, 6: 359188, 7: 91306}

Every graph decomposes within the Hajos bound. Max cycle count never exceeds
the bound in either class (6 and 7 respectively). Hist sums equal totals.

## Count cross-checks (all pass)

- Shard sum reg8n14 = 3,459,386 = full unsharded geng count
  (`harvest/count_5reg14.txt`: `>Z 3459386 graphs generated in 366.72 sec`)
  = OEIS A165626(7) (5-regular graphs on 14 vertices; class generated as
  complements). Fetched from oeis.org by this harvester: confirmed.
- Shard sum reg10n15 = 805,579 = full unsharded geng count
  (`harvest/count_4reg15.txt`: `>Z 805579 graphs generated in 99.94 sec`)
  = OEIS A033301(15) (4-regular graphs on 15 nodes). Fetched: confirmed.

## Independent verification

- Decompositions: sweep.py re-checks every claimed decomposition with
  verify.check_decomposition before counting it (invalid claims discarded);
  escal=0 unknown=0 across all shards.
- Crosschecks (independent exact branch-and-bound + partition check):
  r5_crosscheck_reg8n14.txt (12 samples), r5b_crosscheck_reg8n14.txt
  (8 samples, seed 99, disjoint geng slice), r5_crosscheck_reg10n15.txt (12),
  r5b_crosscheck_reg10n15.txt (8). alarms = 0 in all four (re-grepped by this
  harvester). Copies in `harvest/`.

## Verdict

RESULTS_ROUND5.md is accurate as written. No discrepancies found. No
counterexample: all 4,264,965 graphs across both classes decompose within
the Hajos bound.
